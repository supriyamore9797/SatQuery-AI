import datetime
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import pystac_client
import planetary_computer

router = APIRouter(prefix="/api/v1/catalog", tags=["Catalog"])

class CatalogSearchRequest(BaseModel):
    bbox: List[float]  # [min_lon, min_lat, max_lon, max_lat]
    start_date: str    # YYYY-MM-DD
    end_date: str      # YYYY-MM-DD
    max_cloud_cover: float = 10.0
    collection: str = "sentinel-2-l2a"
    limit: int = 5

@router.post("/search")
def search_catalog(request: CatalogSearchRequest):
    try:
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace
        )
        
        datetime_range = f"{request.start_date}T00:00:00Z/{request.end_date}T23:59:59Z"
        
        query_params = {}
        if request.collection == "sentinel-2-l2a":
            query_params["eo:cloud_cover"] = {"lt": request.max_cloud_cover}
            
        search_args = {
            "collections": [request.collection],
            "bbox": request.bbox,
            "datetime": datetime_range,
            "max_items": request.limit,
            "sortby": [{"field": "datetime", "direction": "desc"}]
        }
        if query_params:
            search_args["query"] = query_params
            
        search = catalog.search(**search_args)
        
        items = list(search.items())
        results = []
        
        for item in items:
            assets_dict = {}
            for name, asset in item.assets.items():
                assets_dict[name] = asset.href
                
            # Default to STAC bbox
            stac_bbox = item.bbox
            raster_bounds = stac_bbox
            width = 0
            height = 0
            crs = ""
            asset_key = "visual"
            asset_href = item.assets.get("visual", item.assets.get("rendered_preview")).href
            
            results.append({
                "scene_id": item.id,
                "datetime": item.datetime.isoformat(),
                "cloud_cover": item.properties.get("eo:cloud_cover", 0.0),
                "stac_bbox": stac_bbox,
                "raster_bounds": raster_bounds,
                "width": width,
                "height": height,
                "crs": crs,
                "asset_key": asset_key,
                "asset_href": asset_href,
                "collection": item.collection_id,
                "assets": assets_dict
            })
            
        return {"results": results}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

import io
from fastapi import Response
import rasterio

from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform
from rasterio.enums import Resampling
import numpy as np

@router.get("/scene/{scene_id}")
def get_scene_metadata(scene_id: str, collection: str = "sentinel-2-l2a"):
    try:
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace
        )
        search = catalog.search(collections=[collection], ids=[scene_id])
        item = next(search.items(), None)
        if not item:
            raise HTTPException(status_code=404, detail="Scene not found")
            
        preview_asset = item.assets.get("rendered_preview") or item.assets.get("visual")
        visual_url = item.assets["visual"].href
        
        with rasterio.Env(CPL_VSIL_CURL_ALLOWED_EXTENSIONS='tif'):
            with rasterio.open(visual_url) as src:
                # We must reproject to EPSG:3857 (Web Mercator) because Leaflet linearly stretches 
                # images in Web Mercator space. If we use EPSG:4326, it will appear vertically squished.
                transform, width, height = calculate_default_transform(
                    src.crs, 'EPSG:3857', src.width, src.height, *src.bounds
                )
                
                # Rasterio's transform_bounds returns (left, bottom, right, top)
                from rasterio.warp import transform_bounds
                # We still return the display bounds in EPSG:4326 because Leaflet's L.imageOverlay API 
                # expects LatLng coordinates, but the image PIXELS must be EPSG:3857
                
                left_3857, bottom_3857, right_3857, top_3857 = rasterio.transform.array_bounds(height, width, transform)
                geo_bounds = transform_bounds('EPSG:3857', 'EPSG:4326', left_3857, bottom_3857, right_3857, top_3857)
                west, south, east, north = geo_bounds
                
                return {
                    "id": item.id,
                    "datetime": item.datetime.isoformat() if item.datetime else None,
                    "bbox": item.bbox,
                    "eo:cloud_cover": item.properties.get("eo:cloud_cover"),
                    "assets": {k: v.to_dict() for k, v in item.assets.items()},
                    "preview_url": f"/api/v1/catalog/scene/{scene_id}/preview.png",
                    "image_url": f"/api/v1/catalog/scene/{scene_id}/preview.png",
                    "bounds": [
                        [south, west],
                        [north, east]
                    ],
                    "source_crs": str(src.crs),
                    "display_crs": "EPSG:3857",
                    "source_width": src.width,
                    "source_height": src.height,
                    "source_bounds": list(src.bounds),
                    "display_width": width,
                    "display_height": height,
                    "asset_key": "rendered_preview",
                    "asset_href": preview_asset.href
                }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

from typing import Optional
import io
from PIL import Image

@router.get("/scene/{scene_id}/true-color/preview")
def render_true_color(scene_id: str, collection: str = "sentinel-2-l2a", vmin: Optional[float] = None, vmax: Optional[float] = None):
    return _render_stac(scene_id, collection, ["B04", "B03", "B02"], vmin, vmax)

@router.get("/scene/{scene_id}/band/{band_id}/preview")
def render_single_band(scene_id: str, band_id: str, collection: str = "sentinel-2-l2a", vmin: Optional[float] = None, vmax: Optional[float] = None):
    return _render_stac(scene_id, collection, [band_id], vmin, vmax)

def _render_stac(scene_id: str, collection: str, bands_to_load: list, vmin: Optional[float], vmax: Optional[float], aoi: Optional[dict] = None):
    try:
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace
        )
        search = catalog.search(collections=[collection], ids=[scene_id])
        item = next(search.items(), None)
        if not item:
            raise HTTPException(status_code=404, detail="Scene not found")

        for b in bands_to_load:
            if b not in item.assets:
                raise HTTPException(status_code=400, detail=f"Band {b} not found in scene")

        with rasterio.Env(CPL_VSIL_CURL_ALLOWED_EXTENSIONS='tif'):
            href0 = item.assets[bands_to_load[0]].href
            with rasterio.open(href0) as src:
                if aoi:
                    from app.processing.raster import get_aoi_window_and_transform
                    window, window_transform = get_aoi_window_and_transform(src, aoi)
                    if window is None:
                        raise HTTPException(status_code=400, detail="Selected AOI does not overlap the selected raster.")
                    window_bounds = rasterio.windows.bounds(window, window_transform)
                    transform, width, height = calculate_default_transform(
                        src.crs, 'EPSG:3857', int(window.width), int(window.height), *window_bounds
                    )
                else:
                    transform, width, height = calculate_default_transform(
                        src.crs, 'EPSG:3857', src.width, src.height, *src.bounds
                    )
                    
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
                out_shape = (dst_height, dst_width)

            data_list = []
            for b in bands_to_load:
                href = item.assets[b].href
                with rasterio.open(href) as src:
                    with WarpedVRT(src, **vrt_options) as vrt:
                        arr = vrt.read(1, out_shape=out_shape, resampling=Resampling.bilinear)
                        data_list.append(arr)
            
            data = np.stack(data_list, axis=0) # shape: (bands, H, W)
            
            # valid mask where all bands > 0
            valid_mask = np.all(data > 0, axis=0)
            alpha = np.where(valid_mask, 255, 0).astype(np.uint8)
            
            # normalize using actual pixel range (2nd and 98th percentile)
            # if there are valid pixels
            if np.any(valid_mask):
                valid_pixels = data[:, valid_mask]
                
                if vmin is not None and vmax is not None:
                    display_min = float(vmin)
                    display_max = float(vmax)
                else:
                    display_min = np.percentile(valid_pixels, 2)
                    display_max = np.percentile(valid_pixels, 98)
                
                if display_max <= display_min:
                    display_max = display_min + 0.001
                    
                data = np.clip((data.astype(np.float32) - display_min) / (display_max - display_min), 0, 1)
            else:
                display_min = 0.0
                display_max = 0.0
                data = np.zeros_like(data, dtype=np.float32)
                
            data = (data * 255).astype(np.uint8)
            
            # --- USER REQUESTED LOGGING ---
            print("="*50)
            print("scene_id:", scene_id)
            print("band(s):", bands_to_load)
            print("width:", dst_width)
            print("height:", dst_height)
            print("dtype:", data.dtype)
            print("crs:", "EPSG:3857")
            print("bounds:", src.bounds if 'src' in locals() else "Unknown")
            print("nodata: 0")
            print("valid_pixel_count:", np.sum(valid_mask))
            if np.any(valid_mask):
                print("min:", np.min(valid_pixels))
                print("max:", np.max(valid_pixels))
            else:
                print("min: N/A", "max: N/A")
            print("display_min:", display_min)
            print("display_max:", display_max)
            print("png_width:", dst_width)
            print("png_height:", dst_height)
            print("="*50)
            # ------------------------------
            
            if len(bands_to_load) == 1:
                # Grayscale: repeat to RGB
                data = np.repeat(data, 3, axis=0)
                
            rgba = np.vstack([data, np.expand_dims(alpha, axis=0)])
            
            # Reorder to (H, W, C)
            rgba = np.transpose(rgba, (1, 2, 0))
            
            img = Image.fromarray(rgba, mode="RGBA")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return Response(content=buf.getvalue(), media_type="image/png")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/scene/{scene_id}/preview.png")
def get_scene_preview(scene_id: str, collection: str = "sentinel-2-l2a"):
    try:
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace
        )
        search = catalog.search(collections=[collection], ids=[scene_id])
        item = next(search.items(), None)
        if not item:
            raise HTTPException(status_code=404, detail="Scene not found")
            
        visual_url = item.assets["visual"].href
        
        with rasterio.Env(CPL_VSIL_CURL_ALLOWED_EXTENSIONS='tif'):
            with rasterio.open(visual_url) as src:
                transform, width, height = calculate_default_transform(
                    src.crs, 'EPSG:3857', src.width, src.height, *src.bounds
                )
                
                vrt_options = {
                    'crs': 'EPSG:3857',
                    'transform': transform,
                    'width': width,
                    'height': height
                }
                
                with WarpedVRT(src, **vrt_options) as vrt:
                    max_dim = 1024
                    scale = max_dim / max(width, height)
                    dst_width = max(1, int(width * scale))
                    dst_height = max(1, int(height * scale))
                    
                    data = vrt.read(
                        out_shape=(3, dst_height, dst_width),
                        resampling=Resampling.bilinear
                    )
                    
                    # Create an alpha channel where nodata (0,0,0) becomes transparent
                    alpha = np.ones((dst_height, dst_width), dtype=np.uint8) * 255
                    alpha[(data[0] == 0) & (data[1] == 0) & (data[2] == 0)] = 0
                    
                    if data.dtype != np.uint8:
                        if np.max(data) > 255:
                            data = np.clip(data / 3000.0 * 255, 0, 255).astype(np.uint8)
                        else:
                            data = data.astype(np.uint8)
                            
                    # Stack RGB and Alpha
                    rgba_data = np.vstack([data, np.expand_dims(alpha, axis=0)])
                            
                    profile = {
                        'driver': 'PNG',
                        'dtype': 'uint8',
                        'width': dst_width,
                        'height': dst_height,
                        'count': 4,
                        'nodata': None
                    }
                    
                    with rasterio.MemoryFile() as mem_file:
                        with mem_file.open(**profile) as dataset:
                            dataset.write(rgba_data)
                        img_bytes = mem_file.read()
                        
        return Response(content=img_bytes, media_type="image/png")
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
