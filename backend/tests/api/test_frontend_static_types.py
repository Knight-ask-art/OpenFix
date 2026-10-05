import mimetypes

import httpx
import pytest

from app.main import SPAStaticFiles


@pytest.mark.asyncio
async def test_frontend_module_types_ignore_host_mime_associations(
    tmp_path, monkeypatch
):
    (tmp_path / "index.html").write_text("<main>OpenFix</main>", encoding="utf-8")
    for name in ("app.js", "chunk.mjs", "app.css", "module.wasm"):
        (tmp_path / name).write_text("asset", encoding="utf-8")
    monkeypatch.setattr(
        mimetypes, "guess_type", lambda *args, **kwargs: ("text/plain", None)
    )
    app = SPAStaticFiles(directory=tmp_path, html=True)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        for name, expected in {
            "app.js": "text/javascript",
            "chunk.mjs": "text/javascript",
            "app.css": "text/css",
            "module.wasm": "application/wasm",
        }.items():
            response = await client.get("/" + name)
            assert response.status_code == 200
            assert response.headers["content-type"].split(";")[0] == expected
        response = await client.get("/outline")
        assert response.status_code == 200
        assert "OpenFix" in response.text
