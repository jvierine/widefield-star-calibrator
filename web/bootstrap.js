import init from "./pkg/wisc_web.js";

init().catch(error => {
  document.getElementById("status").textContent = `WASM startup failed: ${error}`;
});
