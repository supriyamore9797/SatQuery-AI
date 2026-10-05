import uuid
import numpy as np
import rasterio
import rasterio.features
import rasterio.warp
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds
from rasterio.enums import Resampling
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel
import pystac_client
import planetary_computer
import io

router = APIRouter(prefix="/api/v1/analysis", tags=["Analysis"])


class NDVIRequest(BaseModel):
    scene_id: str
    source_type: str = "stac"
    aoi: dict | None = None

# Simple in-memory cache for the generated images to avoid recomputing
NDVI_CACHE = {}

@router.post("/ndvi")
def calculate_ndvi(req: NDVIRequest):
    try:
        from app.processing.raster import get_aoi_window_and_transform
        from rasterio.warp import calculate_default_transform
        
        if req.source_type == "upload":
            import os
            from pathlib import Path
            project_root = Path(__file__).resolve().parent.parent.parent.parent
            dataset_dir = project_root / "temp" / "uploads" / req.scene_id
            
            if not dataset_dir.exists():
                raise HTTPException(status_code=404, detail="Uploaded dataset not found.")
                
            files = list(dataset_dir.glob("*.*"))
            
            # Check for B04 and B08
            b04_path = None
            b08_path = None
            b04_idx = 1
            b08_idx = 1
            
            for f in files:
                if "B04" in f.name.upper():
                    b04_path = str(f)
                elif "B08" in f.name.upper():
                    b08_path = str(f)
                    
            if not b04_path or not b08_path:
                if len(files) == 1:
                    with rasterio.open(str(files[0])) as test_src:
                        if test_src.count >= 4:
                            b04_path = str(files[0])
                            b08_path = str(files[0])
                            b04_idx = 3
                            b08_idx = 4
                
            if not b04_path or not b08_path:
                raise HTTPException(status_code=400, detail="NDVI requires Red (B04) and NIR (B08) bands. The selected raster does not contain both required bands.")
                
            b04_url = b04_path
            b08_url = b08_path
            
        else:
            b04_idx = 1
            b08_idx = 1
            catalog = pystac_client.Client.open(
                "https://planetarycomputer.microsoft.com/api/stac/v1",
                modifier=planetary_computer.sign_inplace
            )
            search = catalog.search(collections=["sentinel-2-l2a"], ids=[req.scene_id])
            item = next(search.items(), None)
            if not item:
                raise HTTPException(status_code=404, detail="Scene not found")
                
            if "B04" not in item.assets or "B08" not in item.assets:
                raise HTTPException(status_code=400, detail="NDVI requires Red (B04) and NIR (B08) bands. The selected raster does not contain both required bands.")
                
            b04_url = item.assets["B04"].href
            b08_url = item.assets["B08"].href

        with rasterio.Env(CPL_VSIL_CURL_ALLOWED_EXTENSIONS='tif'):
            with rasterio.open(b04_url) as src_red, rasterio.open(b08_url) as src_nir:
                if req.aoi:
                    window, window_transform = get_aoi_window_and_transform(src_nir, req.aoi)
                    if window is None:
                        raise HTTPException(status_code=400, detail="Selected AOI does not overlap the selected raster.")
                    
                    window_bounds = rasterio.windows.bounds(window, src_nir.transform)
                    transform, width, height = calculate_default_transform(
                        src_nir.crs, 'EPSG:3857', int(window.width), int(window.height), *window_bounds
                    )
                    
                    geo_bounds = transform_bounds(src_nir.crs, 'EPSG:4326', *window_bounds)
                else:
                    transform, width, height = calculate_default_transform(
                        src_nir.crs, 'EPSG:3857', src_nir.width, src_nir.height, *src_nir.bounds
                    )
                    geo_bounds = transform_bounds(src_nir.crs, 'EPSG:4326', *src_nir.bounds)

                west, south, east, north = geo_bounds
                
                vrt_options = {
                    'crs': 'EPSG:3857',
                    'transform': transform,
                    'width': width,
                    'height': height
                }
                
                max_dim = 1024
                scale = min(1.0, max_dim / max(width, height))
                dst_width = max(1, int(width * scale))
                dst_height = max(1, int(height * scale))
                
                with WarpedVRT(src_red, **vrt_options) as vrt_red, WarpedVRT(src_nir, **vrt_options) as vrt_nir:
                    red_data = vrt_red.read(b04_idx, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear).astype(np.float32)
                    nir_data = vrt_nir.read(b08_idx, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear).astype(np.float32)
                    
                    valid_mask = (red_data > 0) & (nir_data > 0)
                    
                    if req.aoi and req.aoi.get('geometry'):
                        # Scale transform for the scaled output
                        scaled_transform = transform * transform.scale((width / dst_width), (height / dst_height))
                        
                        geom_3857 = rasterio.warp.transform_geom('EPSG:4326', 'EPSG:3857', req.aoi['geometry'])
                        poly_mask = rasterio.features.geometry_mask(
                            [geom_3857],
                            out_shape=(dst_height, dst_width),
                            transform=scaled_transform,
                            invert=True,
                            all_touched=True
                        )
                        valid_mask = valid_mask & poly_mask
                    
                    denominator = nir_data + red_data
                    np.putmask(denominator, denominator == 0, 1e-10)
                    ndvi = (nir_data - red_data) / denominator
                    ndvi[~valid_mask] = np.nan
                    
                    valid_pixels = ndvi[valid_mask]
                    total_pixels = ndvi.size
                    nodata_pixels = total_pixels - valid_pixels.size
                    if valid_pixels.size == 0:
                        raise HTTPException(status_code=400, detail="Selected AOI contains no valid Sentinel-2 pixels. Please select an area within the actual imagery footprint.")
                    
                    if valid_pixels.size > 0:
                        min_val = float(np.min(valid_pixels))
                        max_val = float(np.max(valid_pixels))
                        mean_val = float(np.mean(valid_pixels))
                        median_val = float(np.median(valid_pixels))
                        veg_pixels = np.sum(valid_pixels >= 0.4)
                        veg_pct = float(veg_pixels / valid_pixels.size * 100.0)
                    else:
                        min_val = max_val = mean_val = median_val = veg_pct = 0.0
                        
                    result_id = str(uuid.uuid4())
                    NDVI_CACHE[result_id] = {
                        'ndvi': ndvi,
                        'valid_mask': valid_mask,
                        'width': dst_width,
                        'height': dst_height
                    }
                    
                    return {
                        "scene_id": req.scene_id,
                        "source_dataset": req.scene_id,
                        "source_type": req.source_type,
                        "bands_used": ["B04", "B08"],
                        "analysis": "NDVI",
                        "formula": "(B08 - B04) / (B08 + B04)",
                        "scope": req.aoi.get("shape", "Rectangle") if req.aoi else "Full Scene",
                        "area": req.aoi.get("area", 0) if req.aoi else 0,
                        "statistics": {
                            "min": min_val,
                            "max": max_val,
                            "mean": mean_val,
                            "median": median_val,
                            "total_pixel_count": total_pixels,
                            "valid_pixel_count": int(valid_pixels.size),
                            "nodata_pixel_count": nodata_pixels,
                            "vegetation_area_percentage": veg_pct
                        },
                        "threshold": {
                            "ndvi": 0.4,
                            "meaning": "Prototype vegetation interpretation threshold"
                        },
                        "image_url": f"/api/v1/analysis/result/{result_id}/image.png",
                        "bounds": [
                            [south, west],
                            [north, east]
                        ],
                        "source": {
                            "red": "B04",
                            "nir": "B08"
                        }
                    }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/render")
def render_analysis_image(result_id: str, colormap: str = "ndvi", vmin: float = -1.0, vmax: float = 1.0):
    if result_id not in NDVI_CACHE:
        raise HTTPException(status_code=404, detail="Image not found or expired")
        
    data = NDVI_CACHE[result_id]
    ndvi = data['ndvi']
    valid_mask = data['valid_mask']
    width = data['width']
    height = data['height']
    
    # Clamp vmin and vmax to avoid division by zero
    if vmin >= vmax:
        vmax = vmin + 0.001
        
    r = np.empty_like(ndvi, dtype=np.uint8)
    g = np.empty_like(ndvi, dtype=np.uint8)
    b = np.empty_like(ndvi, dtype=np.uint8)
    
    if colormap == "grayscale":
        # Map vmin to 0 (black), vmax to 255 (white)
        norm = np.clip((ndvi - vmin) / (vmax - vmin), 0, 1)
        gray = (norm * 255).astype(np.uint8)
        r[valid_mask] = gray[valid_mask]
        g[valid_mask] = gray[valid_mask]
        b[valid_mask] = gray[valid_mask]
    elif colormap == "inverted":
        # Inverted NDVI: Map vmax to 0 (black), vmin to 255 (white)
        norm = np.clip((ndvi - vmin) / (vmax - vmin), 0, 1)
        gray = ((1 - norm) * 255).astype(np.uint8)
        r[valid_mask] = gray[valid_mask]
        g[valid_mask] = gray[valid_mask]
        b[valid_mask] = gray[valid_mask]
    else:
        # "ndvi" standard
        mid = (vmin + vmax) / 2.0
        
        mask_neg = (ndvi < mid) & valid_mask
        r[mask_neg] = np.interp(ndvi[mask_neg], [vmin, mid], [165, 255]).astype(np.uint8)
        g[mask_neg] = np.interp(ndvi[mask_neg], [vmin, mid], [0, 255]).astype(np.uint8)
        b[mask_neg] = np.interp(ndvi[mask_neg], [vmin, mid], [38, 191]).astype(np.uint8)
        
        mask_pos = (ndvi >= mid) & valid_mask
        r[mask_pos] = np.interp(ndvi[mask_pos], [mid, vmax], [255, 0]).astype(np.uint8)
        g[mask_pos] = np.interp(ndvi[mask_pos], [mid, vmax], [255, 104]).astype(np.uint8)
        b[mask_pos] = np.interp(ndvi[mask_pos], [mid, vmax], [191, 55]).astype(np.uint8)
        
    # invalid pixels to black (will be masked by alpha)
    r[~valid_mask] = 0
    g[~valid_mask] = 0
    b[~valid_mask] = 0
    
    rgba_uint8 = np.stack([r, g, b, np.where(valid_mask, 255, 0).astype(np.uint8)], axis=-1)
    rgba_bands = np.moveaxis(rgba_uint8, 2, 0)
    
    profile = {
        'driver': 'PNG',
        'dtype': 'uint8',
        'width': width,
        'height': height,
        'count': 4,
        'nodata': None
    }
    
    with rasterio.MemoryFile() as mem_file:
        with mem_file.open(**profile) as dataset:
            dataset.write(rgba_bands)
        img_bytes = mem_file.read()
        
    return Response(content=img_bytes, media_type="image/png")

@router.get('/result/{result_id}/image.png')
def get_analysis_image(result_id: str):
    return render_analysis_image(result_id, colormap='ndvi', vmin=-1.0, vmax=1.0)

