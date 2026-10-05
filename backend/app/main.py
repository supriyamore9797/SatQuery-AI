from pathlib import Path
from dotenv import load_dotenv

# Load .env before any app modules are imported so that singleton services
# (e.g. vqa_service, grounding_service) read the correct env vars at init time.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app.api.upload import router as upload_router
from app.api.preview import router as preview_router
from app.api.pixel import router as pixel_router
from app.api.catalog import router as catalog_router
from app.api.analysis import router as analysis_router
from app.api.vqa import router as vqa_router
from app.api.grounding import router as grounding_router
from app.api.export import router as export_router
from app.api.routing import router as routing_router
from app.api.change import router as change_router
from app.api.cross_modal import router as cross_modal_router
from app.api.registry import router as registry_router
from app.api.benchmark import router as benchmark_router


app = FastAPI(
    title="SatQuery AI",
    description="Agentic Vision-Language Assistant for Remote Sensing",
    version="0.1.0"
)

# Enable CORS for frontend API calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.1:8080", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload_router)
app.include_router(preview_router)
app.include_router(pixel_router)
app.include_router(catalog_router)
app.include_router(analysis_router)
app.include_router(vqa_router)
app.include_router(grounding_router)
app.include_router(export_router)
app.include_router(routing_router)
app.include_router(change_router)
app.include_router(cross_modal_router)
app.include_router(registry_router)
app.include_router(benchmark_router)
# Serve the SatQuery AI frontend
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

if FRONTEND_DIR.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIR / "assets"),
        name="assets"
    )

    @app.get("/app")
    def serve_frontend():
        return FileResponse(FRONTEND_DIR / "index.html")

    @app.get("/styles.css")
    def serve_css():
        return FileResponse(FRONTEND_DIR / "styles.css")

    @app.get("/app.js")
    def serve_js():
        return FileResponse(FRONTEND_DIR / "app.js")


@app.get("/")
def root():
    return {
        "project": "SatQuery AI",
        "status": "running",
        "version": "0.1.0"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }
