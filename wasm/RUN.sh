#!/bin/bash
# Build the WASM module and drop the artefacts into www/ so the demo
# page can `import` them directly without a bundler.
set -euo pipefail
cd "$(dirname "$0")"
wasm-pack build --target web --release
cp pkg/ws_wasm_bg.wasm www/ws_wasm_bg.wasm
cp pkg/ws_wasm.js     www/ws_wasm.js
echo "built; open www/index.html via a local static server"
