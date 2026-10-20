// The viewer runs inside the WebView so JPEG frames never cross the React Native bridge. It
// only draws and acks; the screen owns credentials, reconnects and input. Plain ES2017 in a
// string because Hermes keeps no function source to serialize.
const VIEWER_SCRIPT = `(function () {
  var ACK = '{"type":"ack"}';
  var canvas = document.querySelector("canvas");
  var context = canvas.getContext("2d");
  var socket = null;
  var drawn = false;
  function post(message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  function decode(buffer) {
    var blob = new Blob([buffer], { type: "image/jpeg" });
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var image = new Image();
      image.onload = function () { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      image.src = url;
    });
  }
  function draw(ws, buffer) {
    decode(buffer)
      .then(function (image) {
        if (ws !== socket) return;
        if (canvas.width !== image.width || canvas.height !== image.height) {
          canvas.width = image.width;
          canvas.height = image.height;
        }
        context.drawImage(image, 0, 0);
        if (image.close) image.close();
        if (!drawn) {
          drawn = true;
          post({ type: "frame" });
        }
      })
      .catch(function () {})
      .then(function () {
        // A frame that fails to decode is skipped, not a stalled stream.
        if (ws === socket && ws.readyState === 1) ws.send(ACK);
      });
  }
  function stop() {
    var ws = socket;
    socket = null;
    if (ws) ws.close();
  }
  function connect(url) {
    stop();
    drawn = false;
    var ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onmessage = function (event) {
      if (ws !== socket) return;
      if (typeof event.data === "string") post({ type: "server", text: event.data });
      else draw(ws, event.data);
    };
    ws.onclose = function () {
      if (ws !== socket) return;
      socket = null;
      post({ type: "closed" });
    };
    ws.onerror = function () { ws.close(); };
  }
  function send(text) {
    if (socket && socket.readyState === 1) socket.send(text);
  }
  window.T3Computer = { connect: connect, send: send, stop: stop };
  post({ type: "ready" });
})();`;

/** The WebView page that shows the Computer stream letterboxed on `background`. */
export function computerStreamDocument(background: string): string {
  const failure = `window.ReactNativeWebView.postMessage('{"type":"failed"}');`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; background: ${background.replace(/[^\w\s#(),.%-]/g, "")}; }
  canvas { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
</style></head><body><canvas width="1" height="1"></canvas><script>window.addEventListener("error",function(){${failure}});
${VIEWER_SCRIPT}</script></body></html>`;
}

/** Script that sends one input message on the open socket. */
export const computerSendScript = (message: string): string =>
  `window.T3Computer && window.T3Computer.send(${JSON.stringify(message)}); true;`;

/** Script that (re)connects the viewer to a stream URL. */
export const computerConnectScript = (url: string): string =>
  `window.T3Computer && window.T3Computer.connect(${JSON.stringify(url)}); true;`;

export const COMPUTER_STOP_SCRIPT = "window.T3Computer && window.T3Computer.stop(); true;";
