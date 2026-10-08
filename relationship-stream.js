(function () {
  "use strict";
  var pathMatch = location.pathname.match(/^\/polycule\/([^/]+)$/);
  var id = (pathMatch && pathMatch[1]) || location.hash.slice(1) || "default";
  document.addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("output"); s.style.cssText = "display:block;margin:8px;font:13px system-ui;color:#555"; document.body.insertBefore(s, document.body.firstChild);
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?polycule=" + encodeURIComponent(id));
    s.textContent = "Connecting to #" + id + "...";
    ws.onopen = function () { s.textContent = "Viewing polycule " + id + "."; };
    ws.onmessage = function (event) { var update = JSON.parse(event.data); if (update.event === "updated") location.reload(); if (update.event === "not-found") s.textContent = "This polycule does not exist."; };
    ws.onerror = function () { s.textContent = "Could not connect to the polycule server."; };
  });
}());
