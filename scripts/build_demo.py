"""Build the static live demo for GitHub Pages.

Copies the dashboard as the backend serves it, adds demo/demo.js (the simulator,
rule engine and automations running in the browser) and writes demo-data.json
from the real rules.yaml and circadian keyframes, so the demo uses the same
rules and lighting schedule as the full stack.

    python scripts/build_demo.py _site
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.circadian import KEYFRAMES  # noqa: E402

STATIC = ROOT / "backend" / "app" / "static"


def build(root_out: Path) -> None:
    shutil.rmtree(root_out, ignore_errors=True)
    # The landing page sits at the root; the live dashboard at /live/.
    shutil.copytree(ROOT / "site", root_out, ignore=shutil.ignore_patterns("credits.json"))
    out = root_out / "live"
    shutil.copytree(STATIC, out / "static")
    shutil.copy(ROOT / "demo" / "demo.js", out / "static" / "demo.js")

    rules = yaml.safe_load((ROOT / "backend" / "app" / "rules.yaml").read_text(encoding="utf-8"))
    data = {"rules": rules, "keyframes": KEYFRAMES}
    (out / "static" / "demo-data.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    # Pages serves the site from /<repo>/, so links must be relative. demo.js loads before app.js.
    html = (STATIC / "index.html").read_text(encoding="utf-8").replace('"/static/', '"static/')
    app = '<script src="static/app.js" defer></script>'
    assert app in html, "index.html no longer loads app.js the expected way"
    html = html.replace(app, '<script src="static/demo.js" defer></script>\n  ' + app)
    (out / "index.html").write_text(html, encoding="utf-8")
    (root_out / ".nojekyll").write_text("", encoding="utf-8")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site"
    build(target)
    print(f"demo built in {target}")
