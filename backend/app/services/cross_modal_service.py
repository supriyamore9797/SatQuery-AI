import time
import uuid
import rasterio
import numpy as np
import logging
from rasterio.warp import calculate_default_transform, transform_bounds, Resampling
from rasterio.vrt import WarpedVRT

logger = logging.getLogger(__name__)

# Cache for results
CROSS_MODAL_CACHE = {}

class CrossModalService:
    def _fetch_stac_asset_url(self, scene_id: str, collection: str, asset_name: str) -> str:
        import pystac_client
        import planetary_computer
        
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace
        )
        search = catalog.search(collections=[collection], ids=[scene_id])
        item = next(search.items(), None)
        if not item:
            raise ValueError(f"Scene {scene_id} not found in collection {collection}")
        if asset_name not in item.assets:
            raise ValueError(f"Asset {asset_name} not found in scene {scene_id}")
            
        return item.assets[asset_name].href

    def analyze(self, optical_id: str, sar_id: str, aoi: dict | None = None) -> dict:
        start_time = time.time()
        
        # Determine collections. 
        # For this MVP, we assume Sentinel-2 for optical and Sentinel-1 for SAR.
        # But we could just search both.
        try:
            opt_b03_url = self._fetch_stac_asset_url(optical_id, "sentinel-2-l2a", "B03")
            opt_b08_url = self._fetch_stac_asset_url(optical_id, "sentinel-2-l2a", "B08")
            
            # S1 GRD
            sar_vv_url = self._fetch_stac_asset_url(sar_id, "sentinel-1-grd", "vv")
        except Exception as e:
            logger.error(f"Failed to resolve STAC assets: {e}")
            return {
                "status": "error",
                "error": f"Failed to resolve STAC assets: {e}"
            }
            
        try:
            with rasterio.Env(CPL_VSIL_CURL_ALLOWED_EXTENSIONS='tif'):
                with rasterio.open(opt_b03_url) as src_green, rasterio.open(opt_b08_url) as src_nir, rasterio.open(sar_vv_url) as src_sar:
                    
                    bbox = aoi.get('bbox', aoi) if isinstance(aoi, dict) else (aoi or {})
                    if bbox and "west" in bbox:
                        left, bottom, right, top = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
                        # Transform geographic bounds to web mercator for analysis
                        transform, width, height = calculate_default_transform(
                            'EPSG:4326', 'EPSG:3857', src_green.width, src_green.height,
                            left, bottom, right, top
                        )
                        vrt_options = {
                            'crs': 'EPSG:3857',
                            'transform': transform,
                            'width': width,
                            'height': height
                        }
                    else:
                        # Fallback: process center of optical image
                        return {"status": "error", "error": "AOI is required for cross-modal analysis to align imagery."}

                    # We want to resample to a reasonable size
                    max_dim = 1024
                    scale = min(1.0, max_dim / max(width, height))
                    dst_width = max(1, int(width * scale))
                    dst_height = max(1, int(height * scale))
                    
                    vrt_options['width'] = dst_width
                    vrt_options['height'] = dst_height
                    vrt_options['transform'] = transform * transform.scale((width / dst_width), (height / dst_height))

                    with WarpedVRT(src_green, **vrt_options) as vrt_green, \
                         WarpedVRT(src_nir, **vrt_options) as vrt_nir, \
                         WarpedVRT(src_sar, **vrt_options) as vrt_sar:
                         
                         green_data = vrt_green.read(1, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear).astype(np.float32)
                         nir_data = vrt_nir.read(1, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear).astype(np.float32)
                         sar_data = vrt_sar.read(1, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear).astype(np.float32)
                         
                         valid_mask = (green_data > 0) & (nir_data > 0)
                         
                         # Convert SAR power to dB
                         sar_data = np.where(sar_data > 0, 10 * np.log10(sar_data), -30)
                         
                         # Optical NDWI for Water
                         denominator = green_data + nir_data
                         np.putmask(denominator, denominator == 0, 1e-10)
                         ndwi = (green_data - nir_data) / denominator
                         
                         # 1. Water Evidence
                         # High NDWI (>0.1) and Low SAR Backscatter (<-15 dB)
                         water_opt = (ndwi > 0.1) & valid_mask
                         water_sar = (sar_data < -15) & valid_mask
                         water_fused = water_opt & water_sar
                         
                         water_detected = np.any(water_fused)
                         
                         # 2. Built-up Evidence
                         # Built-up tends to have negative NDWI, positive NDBI, but we don't have SWIR here.
                         # Low NDWI (<-0.1) and High SAR Backscatter (>-5 dB)
                         built_opt = (ndwi < -0.1) & valid_mask
                         built_sar = (sar_data > -5) & valid_mask
                         built_fused = built_opt & built_sar
                         
                         built_detected = np.any(built_fused)
                         
                         result_id = str(uuid.uuid4())
                         
                         # Save fusion masks for visualization (could map to RGB)
                         # Red = Built-up, Blue = Water, Green = SAR/optical background
                         display_img = np.zeros((3, dst_height, dst_width), dtype=np.uint8)
                         
                         # Normalize SAR for background grayscale
                         sar_norm = np.clip((sar_data - (-25)) / 25.0, 0, 1) * 255
                         sar_norm = sar_norm.astype(np.uint8)
                         
                         display_img[0] = sar_norm
                         display_img[1] = sar_norm
                         display_img[2] = sar_norm
                         
                         display_img[0][built_fused] = 255 # Red for built-up
                         display_img[1][built_fused] = 0
                         display_img[2][built_fused] = 0
                         
                         display_img[0][water_fused] = 0
                         display_img[1][water_fused] = 0
                         display_img[2][water_fused] = 255 # Blue for water
                         
                         CROSS_MODAL_CACHE[result_id] = {
                             'image': display_img,
                             'bounds': [[bottom, left], [top, right]]
                         }
                         
                         return {
                             "status": "success",
                             "optical_image": optical_id,
                             "sar_image": sar_id,
                             "result_id": result_id,
                             "analysis": "Optical + SAR complementary fusion",
                             "water": {
                                 "detected": bool(water_detected),
                                 "evidence": "Optical NDWI > 0.1 + SAR VV < -15 dB"
                             },
                             "built_up": {
                                 "detected": bool(built_detected),
                                 "evidence": "Optical NDWI < -0.1 + SAR VV > -5 dB"
                             },
                             "execution_time_ms": int((time.time() - start_time) * 1000),
                             "image_url": f"/api/v1/cross-modal/result/{result_id}/image.png",
                             "bounds": [[bottom, left], [top, right]],
                             "execution_trace": {
                                 "task": "cross_modal",
                                 "model": "optical_sar_fusion",
                                 "provider": "local",
                                 "status": "success",
                                 "parameters": {
                                     "optical_scene": optical_id,
                                     "sar_scene": sar_id,
                                     "optical_bands": ["B03", "B08"],
                                     "sar_bands": ["VV"],
                                     "fusion_method": "Threshold-based boolean intersection"
                                 }
                             }
                         }
        except Exception as e:
            logger.error(f"Cross-modal processing failed: {e}")
            return {
                "status": "error",
                "error": f"Cross-modal processing failed: {e}"
            }

cross_modal_service = CrossModalService()
