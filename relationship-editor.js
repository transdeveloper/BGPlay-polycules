(function () {
  "use strict";

  var pathMatch = location.pathname.match(/^\/polycule\/([^/]+)$/);
  var polyculeId = (pathMatch && pathMatch[1]) || location.hash.slice(1) || "default";
  var isNewPage = location.pathname === "/new";
  var password = sessionStorage.getItem("bgplay-password-" + polyculeId) || "";
  var panel = document.createElement("main");
  panel.className = "polycule-editor";

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character];
    });
  }

  function api(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (password) options.headers["X-BGPlay-Password"] = password;
    return fetch(url, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || "Something went wrong.");
        return body;
      });
    });
  }

  function requestPassword() {
    password = prompt("Enter this polycule's edit password:", password || "") || "";
    sessionStorage.setItem("bgplay-password-" + polyculeId, password);
  }

  function createForm(label) {
    return "<form class='new-polycule editor-form'>" +
      "<label>Optional edit password<input name='password' type='password' placeholder='Leave blank for open editing'></label>" +
      "<button>" + label + "</button></form>";
  }

  function showCreation() {
    panel.innerHTML = "<h1>Create a polycule</h1><p>Start a private or shared space. You will receive a link you can send to others.</p>" +
      "<section class='editor-card'>" + createForm("Create polycule") + "</section>";
    panel.querySelector(".new-polycule").onsubmit = createPolycule;
  }

  function createPolycule(event) {
    event.preventDefault();
    var form = event.currentTarget;
    fetch("/api/polycules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: form.elements.password.value })
    }).then(function (response) { return response.json(); }).then(function (created) {
      location.href = created.url;
    }).catch(function () { alert("Could not create the polycule. Please try again."); });
  }

  function render(document) {
    var shareUrl = location.origin + "/polycule/" + polyculeId;
    var personOptions = document.people.map(function (person) {
      return "<option value='" + escapeHtml(person.id) + "'>" + escapeHtml(person.name) + "</option>";
    }).join("");
    var people = document.people.length ? document.people.map(function (person) {
      return "<div class='item'><span class='item-name'><strong>" + escapeHtml(person.name) + "</strong> <span class='muted'>" + escapeHtml(person.id) + "</span></span>" +
        "<button class='danger' data-person='" + escapeHtml(person.id) + "'>Remove person</button></div>";
    }).join("") : "<p class='muted'>No people yet.</p>";
    var relationships = document.relationships.length ? document.relationships.map(function (relationship) {
      var state = relationship.end ? "<span class='ended'>Ended</span> <button class='secondary' data-revert='" + escapeHtml(relationship.id) + "'>Revert breakup</button>" :
        "<button class='secondary' data-breakup='" + escapeHtml(relationship.id) + "'>Break up</button>";
      return "<div class='item'><span class='item-name'><strong>" + escapeHtml(relationship.source) + "</strong> ↔ <strong>" + escapeHtml(relationship.target) + "</strong> <span class='muted'>" + escapeHtml(relationship.type) + "</span></span>" +
        state + " <button class='danger' data-relationship='" + escapeHtml(relationship.id) + "'>Delete</button></div>";
    }).join("") : "<p class='muted'>Add two people, then connect them.</p>";

    panel.innerHTML = "<h1>Your polycule</h1><p>Use the share link for viewing. Editing is protected only if you chose a password.</p>" +
      "<div class='share-url'><code>" + escapeHtml(shareUrl) + "</code><button class='secondary copy-link'>Copy link</button></div>" +
      "<div class='editor-grid'><section class='editor-card'><h2>New polycule</h2>" + createForm("Create another") + "</section>" +
      "<section class='editor-card'><h2>Add a person</h2><form class='add-person editor-form'><label>Unique ID<input name='id' placeholder='e.g. alex' required></label><label>Name<input name='name' placeholder='e.g. Alex' required></label><button>Add person</button></form></section>" +
      "<section class='editor-card wide'><h2>Connect people</h2><form class='add-relationship editor-form'><label>First person<select name='source' required>" + personOptions + "</select></label><label>Second person<select name='target' required>" + personOptions + "</select></label><label>Relationship type<input name='type' value='relationship'></label><button>Add relationship</button></form></section>" +
      "<section class='editor-card'><h2>People</h2><div class='item-list people-list'>" + people + "</div></section>" +
      "<section class='editor-card'><h2>Relationships</h2><div class='item-list relationship-list'>" + relationships + "</div></section></div>";

    panel.querySelector(".copy-link").onclick = function () { navigator.clipboard.writeText(shareUrl); this.textContent = "Copied"; };
    panel.querySelector(".new-polycule").onsubmit = createPolycule;
    panel.querySelector(".add-person").onsubmit = addPerson;
    panel.querySelector(".add-relationship").onsubmit = addRelationship;
    panel.querySelector(".people-list").onclick = handlePerson;
    panel.querySelector(".relationship-list").onclick = handleRelationship;
  }

  function ensurePassword() { if (!password) requestPassword(); }
  function addPerson(event) {
    event.preventDefault(); ensurePassword(); var form = event.currentTarget;
    api("/api/polycules/" + encodeURIComponent(polyculeId) + "/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: form.elements.id.value, name: form.elements.name.value }) }).then(reload).catch(showError);
  }
  function addRelationship(event) {
    event.preventDefault(); ensurePassword(); var form = event.currentTarget;
    api("/api/polycules/" + encodeURIComponent(polyculeId) + "/relationships", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: form.elements.source.value, target: form.elements.target.value, type: form.elements.type.value }) }).then(reload).catch(showError);
  }
  function handlePerson(event) {
    var id = event.target.dataset.person; if (!id || !confirm("Remove this person and all their relationships?")) return;
    ensurePassword(); api("/api/polycules/" + encodeURIComponent(polyculeId) + "/people/" + encodeURIComponent(id), { method: "DELETE" }).then(reload).catch(showError);
  }
  function handleRelationship(event) {
    var breakup = event.target.dataset.breakup, revert = event.target.dataset.revert, remove = event.target.dataset.relationship;
    if (!breakup && !revert && !remove) return; ensurePassword();
    var base = "/api/polycules/" + encodeURIComponent(polyculeId) + "/relationships/";
    if (breakup) { if (!confirm("Record this breakup now?")) return; api(base + encodeURIComponent(breakup) + "/breakup", { method: "POST" }).then(reload).catch(showError); }
    else if (revert) api(base + encodeURIComponent(revert) + "/revert-breakup", { method: "POST" }).then(reload).catch(showError);
    else if (confirm("Permanently delete this relationship and its history?")) api(base + encodeURIComponent(remove), { method: "DELETE" }).then(reload).catch(showError);
  }
  function reload() { location.reload(); }
  function showError(error) { alert(error.message); }

  document.addEventListener("DOMContentLoaded", function () {
    document.body.insertBefore(panel, document.body.firstChild);
    if (isNewPage) showCreation();
    else api("/api/polycules/" + encodeURIComponent(polyculeId), { headers: {} }).then(render).catch(function (error) { panel.innerHTML = "<h1>Polycule unavailable</h1><p>" + escapeHtml(error.message) + "</p>"; });
  });
}());
