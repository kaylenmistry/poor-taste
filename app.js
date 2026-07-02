(function () {
  "use strict";

  var STORAGE_KEY = "poor-taste-state-v1";
  var VOTER_KEY = "poor-taste-voter-id";
  var GUEST_NAME_KEY = "poor-taste-guest-name";
  var SESSION_CODE_KEY = "poor-taste-session-code";
  var CX = 500, CY = 500, OUTER = 430;
  var LEVEL_PCT = [9.5, 8, 7, 6.5, 6];

  var defaultState = {
    tasters: 4,
    locked: false,
    competitors: [],
    nextId: 1,
    votes: {},
    anonymous: false,
    revealed: {},
    overrides: {},
    focusedMatch: null,
    voters: {}
  };

  var urlParams = new URLSearchParams(location.search);
  var joinId = urlParams.get("join");
  var isGuest = !!joinId;

  function getOrCreateVoterId() {
    var id = localStorage.getItem(VOTER_KEY);
    if (!id) {
      id = "v-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(VOTER_KEY, id);
    }
    return id;
  }
  var myVoterId = getOrCreateVoterId();
  var spotlightVoterId = null;
  var showFocusPanel = true;

  var state = isGuest ? JSON.parse(JSON.stringify(defaultState)) : loadState();

  // ---------- persistence ----------

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        return Object.assign({}, defaultState, parsed);
      }
    } catch (e) {
      console.warn("Could not read saved state, starting fresh.", e);
    }
    return JSON.parse(JSON.stringify(defaultState));
  }

  function saveState() {
    if (isGuest) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      alert("Couldn't save — your browser storage might be full. Try removing a wine photo and adding a smaller one.");
    }
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function initials(name) {
    var parts = name.trim().split(/\s+/);
    return ((parts[0] || "")[0] || "").toUpperCase() + ((parts[1] || "")[0] || "").toUpperCase();
  }

  function avatarInnerHTML(c) {
    if (c.img) return '<img src="' + c.img + '" alt="" />';
    return '<div class="avatar-initials">' + esc(initials(c.name)) + "</div>";
  }

  function withTransition(fn) {
    if (document.startViewTransition) document.startViewTransition(fn);
    else fn();
  }

  function compressImage(file, maxSize, quality) {
    maxSize = maxSize || 220;
    quality = quality || 0.72;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxSize / Math.max(w, h));
          w = Math.round(w * scale);
          h = Math.round(h * scale);
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---------- vote model (per-voter identity) ----------

  function votesNeeded() { return Math.floor(state.tasters / 2) + 1; }
  function matchKey(r, i) { return r + "-" + i; }

  function getMatchVotes(r, i) {
    return state.votes[matchKey(r, i)] || { byVoter: {}, manualOthers: { a: 0, b: 0 } };
  }
  function countFor(r, i, side) {
    var v = getMatchVotes(r, i);
    var n = v.manualOthers[side] || 0;
    Object.keys(v.byVoter).forEach(function (vid) { if (v.byVoter[vid] === side) n++; });
    return n;
  }
  function getVote(r, i, side) {
    var v = getMatchVotes(r, i);
    return {
      yourVote: v.byVoter[myVoterId] === side,
      count: countFor(r, i, side),
      manual: v.manualOthers[side] || 0
    };
  }
  function castVote(r, i, side, voterId) {
    var mk = matchKey(r, i);
    var v = state.votes[mk] || { byVoter: {}, manualOthers: { a: 0, b: 0 } };
    v.byVoter[voterId] = side;
    state.votes[mk] = v;
  }
  function removeVoteFor(r, i, voterId) {
    var mk = matchKey(r, i);
    var v = state.votes[mk];
    if (v && v.byVoter) delete v.byVoter[voterId];
  }
  function setManualOthers(r, i, side, count) {
    var mk = matchKey(r, i);
    var v = state.votes[mk] || { byVoter: {}, manualOthers: { a: 0, b: 0 } };
    v.manualOthers[side] = Math.max(0, count);
    state.votes[mk] = v;
  }
  function totalVotesFor(r, i) { return getVote(r, i, "a").count + getVote(r, i, "b").count; }
  function isFullyVoted(r, i) { return totalVotesFor(r, i) >= state.tasters; }
  function isRevealed(r, i) { return !!state.revealed[matchKey(r, i)]; }
  function clearMatchVotes(r, i) {
    delete state.votes[matchKey(r, i)];
    delete state.revealed[matchKey(r, i)];
    delete state.overrides[matchKey(r, i)];
  }
  // Wipes all match-level state. Needed whenever the bracket shape changes
  // (wines added/removed/reordered) — otherwise stale votes/reveals/overrides
  // from the old bracket get reused for unrelated matchups at the same
  // round/index (e.g. an old override silently declaring seed 1 the winner).
  function resetBracketState() {
    state.votes = {};
    state.revealed = {};
    state.overrides = {};
    state.focusedMatch = null;
  }

  // ---------- bracket math ----------

  function bracketSizeFor(n) {
    if (n <= 0) return 0;
    if (n === 1) return 2;
    var p = 2;
    while (p < n) p *= 2;
    return Math.min(p, 32);
  }

  function seedOrder(size) {
    var seeds = [1];
    var rounds = Math.log2(size);
    for (var r = 0; r < rounds; r++) {
      var s = [];
      var n = seeds.length * 2 + 1;
      for (var i = 0; i < seeds.length; i++) { s.push(seeds[i]); s.push(n - seeds[i]); }
      seeds = s;
    }
    return seeds;
  }

  function buildData() {
    var n = state.competitors.length;
    var size = bracketSizeFor(n);
    if (size === 0) return null;
    var order = seedOrder(size);
    var slots = order.map(function (seed) { return seed <= n ? state.competitors[seed - 1] : "BYE"; });
    var R = Math.log2(size);
    var rounds = [];
    var r0 = [];
    for (var i = 0; i < slots.length; i += 2) r0.push({ a: slots[i], b: slots[i + 1], winner: null });
    rounds.push(r0);
    for (var r = 1; r < R; r++) {
      var cur = [];
      for (var k = 0; k < rounds[r - 1].length; k += 2) cur.push({ a: null, b: null, winner: null });
      rounds.push(cur);
    }
    var needed = votesNeeded();
    function resolve(r, i) {
      var m = rounds[r][i];
      if (m.winner) return m.winner;
      if (m.a === "BYE" && m.b === "BYE") { m.winner = "BYE"; return m.winner; }
      if (m.a === "BYE" && m.b) { m.winner = m.b; return m.winner; }
      if (m.b === "BYE" && m.a) { m.winner = m.a; return m.winner; }
      if (m.a && m.b && m.a !== "BYE" && m.b !== "BYE" && state.locked) {
        var override = state.overrides[matchKey(r, i)];
        if (override === "a") { m.winner = m.a; return m.winner; }
        if (override === "b") { m.winner = m.b; return m.winner; }
        if (isRevealed(r, i)) {
          var va = getVote(r, i, "a").count, vb = getVote(r, i, "b").count;
          if (va >= needed) m.winner = m.a; else if (vb >= needed) m.winner = m.b;
        }
      }
      return m.winner;
    }
    for (var i0 = 0; i0 < rounds[0].length; i0++) resolve(0, i0);
    for (var r2 = 1; r2 < R; r2++) {
      for (var k2 = 0; k2 < rounds[r2].length; k2++) {
        rounds[r2][k2].a = resolve(r2 - 1, k2 * 2) || null;
        rounds[r2][k2].b = resolve(r2 - 1, k2 * 2 + 1) || null;
        resolve(r2, k2);
      }
    }

    // Third-place playoff: the two semifinal losers face off, tracked under
    // the synthetic "T"/0 match key so it can reuse the normal vote/reveal/
    // override machinery without touching the circular bracket's rounds[].
    var thirdPlace = null;
    var runnerUp = null;
    function loserOf(m) {
      if (!m.winner || m.winner === "BYE") return null;
      if (!m.a || !m.b || m.a === "BYE" || m.b === "BYE") return null;
      return m.winner.id === m.a.id ? m.b : m.a;
    }
    if (R >= 2) {
      var semiA = rounds[R - 2][0], semiB = rounds[R - 2][1];
      thirdPlace = { a: loserOf(semiA), b: loserOf(semiB), winner: null };
      if (thirdPlace.a && thirdPlace.b) {
        var tOverride = state.overrides[matchKey("T", 0)];
        if (tOverride === "a") thirdPlace.winner = thirdPlace.a;
        else if (tOverride === "b") thirdPlace.winner = thirdPlace.b;
        else if (isRevealed("T", 0)) {
          var vaT = getVote("T", 0, "a").count, vbT = getVote("T", 0, "b").count;
          if (vaT >= needed) thirdPlace.winner = thirdPlace.a;
          else if (vbT >= needed) thirdPlace.winner = thirdPlace.b;
        }
      }
    }
    var finalMatch = rounds[R - 1][0];
    runnerUp = loserOf(finalMatch);

    var slotIndex = {};
    slots.forEach(function (s, i) { if (s && s !== "BYE") slotIndex[s.id] = i; });
    function leafAngle(i) {
      var STEP = 360 / size;
      return i < size / 2 ? -(i + 0.5) * STEP : (i - size / 2 + 0.5) * STEP;
    }
    var matchAngle = [];
    matchAngle[0] = rounds[0].map(function (_, i) { return (leafAngle(2 * i) + leafAngle(2 * i + 1)) / 2; });
    for (var r3 = 1; r3 < R; r3++) {
      matchAngle[r3] = rounds[r3].map(function (_, i) { return (matchAngle[r3 - 1][2 * i] + matchAngle[r3 - 1][2 * i + 1]) / 2; });
    }
    var ECHO_R = [];
    for (var k3 = 0; k3 <= R; k3++) ECHO_R.push(OUTER * (R - k3) / R);
    return { size: size, R: R, rounds: rounds, needed: needed, slots: slots, slotIndex: slotIndex, leafAngle: leafAngle, matchAngle: matchAngle, ECHO_R: ECHO_R, thirdPlace: thirdPlace, runnerUp: runnerUp };
  }

  function pt(radius, angDeg) {
    var r = (angDeg * Math.PI) / 180;
    return [CX + radius * Math.sin(r), CY - radius * Math.cos(r)];
  }

  function connectorPath(data, r, i) {
    var Rc = data.ECHO_R[r], Rp = data.ECHO_R[r + 1];
    var a1 = r === 0 ? data.leafAngle(2 * i) : data.matchAngle[r - 1][2 * i];
    var a2 = r === 0 ? data.leafAngle(2 * i + 1) : data.matchAngle[r - 1][2 * i + 1];
    var ap = data.matchAngle[r][i];
    var C1 = pt(Rc, a1), C2 = pt(Rc, a2), A1 = pt(Rp, a1), A2 = pt(Rp, a2), P = pt(Rp, ap);
    var cx = 2 * P[0] - (A1[0] + A2[0]) / 2, cy = 2 * P[1] - (A1[1] + A2[1]) / 2;
    return "M" + C1[0] + " " + C1[1] + " L" + A1[0] + " " + A1[1] + " Q" + cx + " " + cy + " " + A2[0] + " " + A2[1] + " L" + C2[0] + " " + C2[1];
  }

  function statusFor(data, si, compId) {
    var k = 0, eliminated = false;
    for (var r = 0; r < data.R; r++) {
      var idx = Math.floor(si / Math.pow(2, r + 1));
      var m = data.rounds[r][idx];
      if (m.winner && m.winner !== "BYE" && m.winner.id === compId) { k = r + 1; continue; }
      if (m.winner && m.winner !== "BYE" && m.winner.id !== compId) eliminated = true;
      break;
    }
    return { roundsWon: k, eliminated: eliminated };
  }

  function sideAt(si, round) { return Math.floor(si / Math.pow(2, round)) % 2 === 0 ? "a" : "b"; }
  function idxAt(si, round) { return Math.floor(si / Math.pow(2, round + 1)); }

  // ---------- networking (PeerJS) ----------

  var peer = null;
  var guestConns = {}; // host side: connId -> {conn, voterId, name}
  var hostConn = null; // guest side
  var reconnectTimer = null;

  function shortCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }
  function peerIdFromCode(code) { return "pt" + code; }

  // Reuse the same join code across host page refreshes so any link/QR
  // already shared stays valid — otherwise every refresh strands voters.
  function getOrCreateSessionCode() {
    var code = localStorage.getItem(SESSION_CODE_KEY);
    if (!code) {
      code = shortCode();
      localStorage.setItem(SESSION_CODE_KEY, code);
    }
    return code;
  }

  function publicState() {
    return {
      tasters: state.tasters,
      locked: state.locked,
      competitors: state.competitors,
      votes: state.votes,
      anonymous: state.anonymous,
      revealed: state.revealed,
      overrides: state.overrides,
      focusedMatch: state.focusedMatch,
      voters: state.voters
    };
  }

  function broadcastState() {
    if (isGuest) return;
    var payload = { type: "state", state: publicState() };
    Object.keys(guestConns).forEach(function (k) {
      var g = guestConns[k];
      if (g.conn.open) g.conn.send(payload);
    });
  }

  function updateConnectedUI() {
    var list = Object.keys(guestConns).map(function (k) { return guestConns[k].name; }).filter(Boolean);
    var count = Object.keys(guestConns).length;
    els.connectedCount.textContent = count + " connected" + (list.length ? ": " + list.join(", ") : "");
  }

  function applyHostAction(action, round, idx, side, voterId) {
    var mk = matchKey(round, idx);
    if (action === "vote") castVote(round, idx, side, voterId);
    else if (action === "unvote") removeVoteFor(round, idx, voterId);
    else if (action === "reveal") state.revealed[mk] = true;
    else if (action === "revote") clearMatchVotes(round, idx);
    else if (action === "declare-a") state.overrides[mk] = "a";
    else if (action === "declare-b") state.overrides[mk] = "b";
  }

  function doAction(action, round, idx, side) {
    if (isGuest) {
      sendGuestAction(action, round, idx, side);
      return;
    }
    applyHostAction(action, round, idx, side, myVoterId);
    saveState();
    afterMutation();
  }

  function doManual(round, idx, side, count) {
    if (isGuest) return;
    setManualOthers(round, idx, side, count);
    saveState();
    afterMutation();
  }

  function afterMutation() {
    renderAll();
    refreshOpenCards();
    broadcastState();
  }

  function startSession(silent) {
    if (typeof Peer === "undefined") {
      if (!silent) alert("Couldn't load the networking library. Check your connection and try again.");
      return;
    }
    if (!state.voters[myVoterId]) state.voters[myVoterId] = "Host";
    var code = getOrCreateSessionCode();
    peer = new Peer(peerIdFromCode(code));
    peer.on("open", function () {
      var url = location.origin + location.pathname + "?join=" + code;
      els.startSessionBtn.hidden = true;
      els.sessionActive.hidden = false;
      els.qrCode.innerHTML = "";
      new QRCode(els.qrCode, { text: url, width: 120, height: 120, colorDark: "#f5efe4", colorLight: "#2b2420", correctLevel: QRCode.CorrectLevel.M });
      els.joinCode.textContent = code;
      els.copyLinkBtn.dataset.url = url;
      updateConnectedUI();
    });
    peer.on("connection", function (conn) {
      guestConns[conn.peer] = { conn: conn, voterId: null, name: "" };
      conn.on("data", function (msg) { handleGuestMessage(conn, msg); });
      conn.on("close", function () { delete guestConns[conn.peer]; updateConnectedUI(); });
    });
    peer.on("error", function (err) {
      console.warn("Peer error", err);
      if (peer) peer.destroy();
      peer = null;
      els.startSessionBtn.hidden = false;
      els.sessionActive.hidden = true;
      if (err && err.type === "unavailable-id") {
        // Stale id from a previous tab/tab-close — mint a fresh code and retry once.
        localStorage.removeItem(SESSION_CODE_KEY);
        startSession(silent);
        return;
      }
      if (!silent) alert("Couldn't start the session (" + (err && err.type || "connection error") + "). Try again.");
    });
  }

  function handleGuestMessage(conn, msg) {
    if (msg.type === "hello") {
      guestConns[conn.peer].voterId = msg.voterId;
      guestConns[conn.peer].name = msg.name || "Guest";
      state.voters[msg.voterId] = msg.name || "Guest";
      saveState();
      updateConnectedUI();
      renderVoterRow();
      conn.send({ type: "state", state: publicState() });
      broadcastState();
    } else if (msg.type === "action") {
      applyHostAction(msg.action, msg.round, msg.idx, msg.side, msg.voterId);
      saveState();
      afterMutation();
    }
  }

  function stopSession() {
    Object.keys(guestConns).forEach(function (k) { guestConns[k].conn.close(); });
    guestConns = {};
    if (peer) peer.destroy();
    peer = null;
    localStorage.removeItem(SESSION_CODE_KEY);
    els.startSessionBtn.hidden = false;
    els.sessionActive.hidden = true;
  }

  function setConnectionStatus(mode, text) {
    els.connectionPill.hidden = false;
    els.connectionDot.className = "connection-dot " + mode;
    els.connectionText.textContent = text;
    els.connectionHomeBtn.hidden = !(isGuest && mode === "off");
    if (isGuest && joinId) {
      els.roomBadge.hidden = false;
      els.roomBadge.textContent = "Room " + joinId;
    }
  }

  function joinSession(hostId, name) {
    if (typeof Peer === "undefined") { setConnectionStatus("off", "Couldn't load the networking library"); return; }
    peer = new Peer();
    peer.on("open", function () {
      connectToHost(hostId, name);
    });
    peer.on("error", function (err) {
      console.warn("Peer error", err);
      var msg = (err && err.type === "peer-unavailable") ? "This session isn't active anymore" : "Couldn't connect";
      setConnectionStatus("off", msg);
    });
  }

  function connectToHost(hostId, name) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConnectionStatus("", "Connecting…");
    hostConn = peer.connect(peerIdFromCode(hostId), { reliable: true });
    hostConn.on("open", function () {
      hostConn.send({ type: "hello", voterId: myVoterId, name: name });
      setConnectionStatus("on", "Connected as " + name);
    });
    hostConn.on("data", function (msg) {
      if (msg.type === "state") applyRemoteState(msg.state);
    });
    hostConn.on("close", function () {
      setConnectionStatus("off", "Disconnected — reconnecting…");
      reconnectTimer = setTimeout(function () { connectToHost(hostId, name); }, 3000);
    });
  }

  function applyRemoteState(remote) {
    state.tasters = remote.tasters;
    state.locked = remote.locked;
    state.competitors = remote.competitors;
    state.votes = remote.votes;
    state.anonymous = remote.anonymous;
    state.revealed = remote.revealed;
    state.overrides = remote.overrides;
    state.focusedMatch = remote.focusedMatch;
    state.voters = remote.voters || {};
    renderAll();
    refreshOpenCards();
  }

  function sendGuestAction(action, round, idx, side) {
    if (hostConn && hostConn.open) {
      hostConn.send({ type: "action", action: action, round: round, idx: idx, side: side, voterId: myVoterId });
    }
  }

  // ---------- rendering ----------

  var els = {};
  function cacheEls() {
    [
      "svgLayer", "avatarLayer", "bracketWrap", "statLine", "chips", "wineToggle", "wineToggleLabel",
      "wineToggleIcon", "winePanel", "manageBlock", "lockedNote", "lockBtn", "lockIconOpen", "lockIconClosed",
      "tVal", "tMinus", "tPlus", "anonToggle", "anonInfoBtn", "anonTooltip", "modal", "backdrop",
      "modalTitle", "modalBody", "modalClose", "modalBack",
      "wname", "wby", "wdesc", "wimg", "photoBtn", "addBtn", "menuBtn", "menuPanel", "exportBtn",
      "importBtn", "importInput", "resetBtn", "sessionBlock", "startSessionBtn", "sessionActive", "qrCode",
      "copyLinkBtn", "connectedCount", "stopSessionBtn", "connectionPill", "connectionDot", "connectionText",
      "roomBadge", "connectionHomeBtn", "joinHomeBtn",
      "joinScreen", "mainApp", "joinName", "joinBtn", "joinStatus", "joinIntro", "focusToggle", "focusPanel", "voterRow",
      "sessionDetailsToggle", "sessionDetails", "joinCode", "joinByCodeRow", "joinByCodeBtn", "joinByCodeForm",
      "joinCodeInput", "joinByCodeSubmit", "podium", "thirdPlacePanel"
    ].forEach(function (id) { els[id] = document.getElementById(id); });
  }

  var pendingImg = null;
  var formOpen = false;
  var modalKind = null; // "edit" | "h2h" | null
  var modalCompId = null;
  var modalMatch = null; // {round, idx}
  var modalReturnTo = null; // {round, idx} to go back to from an edit-modal opened via "view details"

  function renderAll() {
    renderChips();
    renderBracket();
    renderLockUI();
    renderFocusPanel();
    renderThirdPlacePanel();
    renderVoterRow();
    els.anonToggle.setAttribute("aria-checked", String(state.anonymous));
  }

  function moveCompetitor(id, dir) {
    if (state.locked) return;
    var idx = state.competitors.findIndex(function (c) { return c.id === id; });
    var newIdx = idx + dir;
    if (idx < 0 || newIdx < 0 || newIdx >= state.competitors.length) return;
    var tmp = state.competitors[idx];
    state.competitors[idx] = state.competitors[newIdx];
    state.competitors[newIdx] = tmp;
    resetBracketState();
    saveState();
    renderAll();
  }

  function renderChips() {
    var n = state.competitors.length;
    els.chips.innerHTML = state.competitors.map(function (c, i) {
      return (
        '<div class="chip">' +
        '<span class="chip-seed">' + (i + 1) + "</span>" +
        '<span class="chip-avatar">' + avatarInnerHTML(c) + "</span>" +
        "<span>" + esc(c.name) + (c.by ? '<span class="by"> &middot; ' + esc(c.by) + "</span>" : "") + "</span>" +
        '<button class="chip-move" data-move-up="' + c.id + '" aria-label="Move ' + esc(c.name) + ' up the seeding"' + (i === 0 ? " disabled" : "") + '>' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 15l6-6 6 6"/></svg>' +
        "</button>" +
        '<button class="chip-move" data-move-down="' + c.id + '" aria-label="Move ' + esc(c.name) + ' down the seeding"' + (i === n - 1 ? " disabled" : "") + '>' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>' +
        "</button>" +
        '<button class="chip-remove" data-remove="' + c.id + '" aria-label="Remove ' + esc(c.name) + '">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        "</button></div>"
      );
    }).join("");
    Array.prototype.forEach.call(els.chips.querySelectorAll("[data-remove]"), function (btn) {
      btn.addEventListener("click", function () {
        if (state.locked) return;
        var id = Number(this.getAttribute("data-remove"));
        state.competitors = state.competitors.filter(function (c) { return c.id !== id; });
        resetBracketState();
        saveState();
        renderAll();
      });
    });
    Array.prototype.forEach.call(els.chips.querySelectorAll("[data-move-up]"), function (btn) {
      btn.addEventListener("click", function () { moveCompetitor(Number(this.getAttribute("data-move-up")), -1); });
    });
    Array.prototype.forEach.call(els.chips.querySelectorAll("[data-move-down]"), function (btn) {
      btn.addEventListener("click", function () { moveCompetitor(Number(this.getAttribute("data-move-down")), 1); });
    });
    els.wineToggleLabel.textContent = state.competitors.length + " wine" + (state.competitors.length !== 1 ? "s" : "") + " · manage";
  }

  function renderBracket() {
    var n = state.competitors.length;
    if (n === 0) {
      els.bracketWrap.classList.add("empty");
      els.svgLayer.innerHTML = "";
      els.avatarLayer.innerHTML = "";
      els.statLine.textContent = "";
      els.podium.hidden = true;
      return;
    }
    els.bracketWrap.classList.remove("empty");
    var data = buildData();
    var byes = data.size - n;
    els.statLine.innerHTML =
      "<strong>" + n + "</strong> wine" + (n !== 1 ? "s" : "") +
      " · ring <strong>" + data.size + "</strong>" +
      (byes > 0 ? " · " + byes + " bye" + (byes !== 1 ? "s" : "") : "") +
      " · majority " + data.needed + " of " + state.tasters;

    var svgPaths = "", svgDots = "";
    for (var r = 0; r < data.R; r++) {
      for (var i = 0; i < data.rounds[r].length; i++) {
        svgPaths += '<path d="' + connectorPath(data, r, i) + '" fill="none" stroke="var(--line)" stroke-opacity="0.5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
        if (!data.rounds[r][i].winner) {
          var p = pt(data.ECHO_R[r + 1], data.matchAngle[r][i]);
          var tied = data.rounds[r][i].a && data.rounds[r][i].b && data.rounds[r][i].a !== "BYE" && data.rounds[r][i].b !== "BYE" && isRevealed(r, i);
          svgDots += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (tied ? 5 : 4) + '" fill="' + (tied ? "var(--danger)" : "var(--muted)") + '"/>';
        }
      }
    }
    var lineOpacity = spotlightVoterId ? "0.15" : "1";
    els.svgLayer.innerHTML = '<g style="opacity:' + lineOpacity + ';transition:opacity .2s;">' + svgPaths + svgDots + "</g>";

    var avatars = "";
    var championComp = null;
    state.competitors.forEach(function (c) {
      var si = data.slotIndex[c.id];
      if (si === undefined) return;
      var st = statusFor(data, si, c.id);
      if (st.roundsWon === data.R) championComp = c;
      for (var k = 0; k <= st.roundsWon; k++) {
        var radius = data.ECHO_R[k];
        var angle = k === 0 ? data.leafAngle(si) : data.matchAngle[k - 1][idxAt(si, k - 1)];
        var p = pt(radius, angle);
        var isChamp = k === data.R;
        var isFrontier = k === st.roundsWon;
        var pinnedRound = isChamp ? data.R - 1 : k;
        var pinnedIdx = idxAt(si, pinnedRound), pinnedSide = sideAt(si, pinnedRound);
        var pinnedMatch = data.rounds[pinnedRound][pinnedIdx];
        var votable = pinnedMatch.a && pinnedMatch.b && pinnedMatch.a !== "BYE" && pinnedMatch.b !== "BYE";
        var pct = isChamp ? 13 : LEVEL_PCT[Math.min(k, 4)];
        var border = "2px solid var(--border)";
        var faded = "";
        var badge = "";
        var crown = "";
        if (isChamp) {
          border = "3px solid var(--gold)";
        } else if (isFrontier && st.eliminated) {
          faded = "filter:grayscale(0.75);";
        } else if (isFrontier && st.roundsWon < data.R && votable) {
          var tiedHere = !pinnedMatch.winner && isRevealed(pinnedRound, pinnedIdx);
          var vHere = getVote(pinnedRound, pinnedIdx, pinnedSide);
          if (tiedHere) border = "3px solid var(--danger)";
          else border = vHere.yourVote ? "3px solid var(--accent)" : "2px solid var(--border)";
        }
        if (k < st.roundsWon) crown = '<span class="avatar-crown" title="Won this match">&#128081;</span>';
        if (votable) {
          var vBadge = getVote(pinnedRound, pinnedIdx, pinnedSide);
          if (vBadge.count > 0 && isRevealed(pinnedRound, pinnedIdx)) {
            badge = '<span class="avatar-badge">' + vBadge.count + "</span>";
          }
        }
        if (spotlightVoterId && !isChamp) {
          var mvHere = getMatchVotes(pinnedRound, pinnedIdx);
          var canSee = !state.anonymous || isRevealed(pinnedRound, pinnedIdx);
          var pick = canSee && mvHere.byVoter[spotlightVoterId] === pinnedSide;
          if (!pick) faded += "opacity:0.25;";
          else border = "3px solid var(--accent)";
        } else if (spotlightVoterId && isChamp) {
          faded += "opacity:0.25;";
        }
        avatars +=
          '<div class="avatar" data-comp="' + c.id + '" data-round="' + pinnedRound + '" data-match="' + pinnedIdx + '" style="left:' + p[0] / 10 + "%;top:" + p[1] / 10 + "%;width:" + pct + "%;height:" + pct + "%;" + faded + '">' +
          '<div class="avatar-inner" style="border:' + border + ';">' + avatarInnerHTML(c) + "</div>" +
          crown + badge + "</div>";
      }
    });

    var center = championComp
      ? '<div class="champion-banner"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 21h8M12 17v4M5 4h14l-1 5a6 6 0 0 1-12 0L5 4z"/><path d="M5 4H3a2 2 0 0 0 0 4M19 4h2a2 2 0 0 1 0 4"/></svg><span>' + esc(championComp.name) + "</span></div>"
      : '<div class="trophy-empty"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 21h8M12 17v4M5 4h14l-1 5a6 6 0 0 1-12 0L5 4z"/><path d="M5 4H3a2 2 0 0 0 0 4M19 4h2a2 2 0 0 1 0 4"/></svg></div>';

    els.avatarLayer.innerHTML = avatars + center;
    renderPodium(data, championComp);
    Array.prototype.forEach.call(els.avatarLayer.querySelectorAll("[data-comp]"), function (el) {
      el.addEventListener("click", function () {
        var round = Number(this.getAttribute("data-round"));
        var idx = Number(this.getAttribute("data-match"));
        var compId = Number(this.getAttribute("data-comp"));
        if (state.locked) {
          openHeadToHeadModal(round, idx);
        } else {
          openEditModal(compId);
        }
      });
    });
  }

  function renderLockUI() {
    els.lockIconClosed.hidden = !state.locked;
    els.lockIconOpen.hidden = state.locked;
    els.lockBtn.setAttribute("aria-pressed", String(state.locked));
    els.lockBtn.setAttribute("aria-label", state.locked ? "Unlock configuration" : "Lock configuration");
    els.manageBlock.style.display = state.locked ? "none" : "block";
    els.lockedNote.hidden = !state.locked;
    els.tMinus.disabled = state.locked;
    els.tPlus.disabled = state.locked;
    if (!isGuest) els.sessionBlock.hidden = !state.locked;
  }

  function renderVoterRow() {
    var ids = Object.keys(state.voters || {});
    if (!state.locked || ids.length === 0) { els.voterRow.innerHTML = ""; return; }
    els.voterRow.innerHTML = ids.map(function (vid) {
      var label = vid === myVoterId ? "You" : (state.voters[vid] || "Guest");
      var pressed = spotlightVoterId === vid;
      return '<button class="voter-pill" data-voter="' + esc(vid) + '" aria-pressed="' + pressed + '">' + esc(label) + "</button>";
    }).join("");
    Array.prototype.forEach.call(els.voterRow.querySelectorAll("[data-voter]"), function (btn) {
      btn.addEventListener("click", function () {
        var vid = this.getAttribute("data-voter");
        spotlightVoterId = spotlightVoterId === vid ? null : vid;
        renderVoterRow();
        renderBracket();
      });
    });
  }

  // ---------- head-to-head card (shared by modal + focus panel) ----------

  function headToHeadHTML(round, idx) {
    var data = buildData();
    var m = round === "T" ? (data && data.thirdPlace) : (data && data.rounds[round] && data.rounds[round][idx]);
    if (!data || !m) return '<div class="h2h-status">This match is no longer available.</div>';

    function sideHTML(side) {
      var comp = side === "a" ? m.a : m.b;
      if (comp === "BYE") return '<div class="h2h-side"><div class="h2h-placeholder">Bye</div></div>';
      if (!comp) return '<div class="h2h-side"><div class="h2h-placeholder">TBD</div></div>';
      var v = getVote(round, idx, side);
      var locked = isRevealed(round, idx);
      var body = "";
      if (locked) {
        if (v.yourVote) body += '<div class="h2h-count">You voted for this</div>';
        body += '<div class="h2h-count">' + v.count + " vote" + (v.count !== 1 ? "s" : "") + "</div>";
      } else {
        body += v.yourVote
          ? '<button class="vote-btn remove h2h-vote-btn" data-action="unvote" data-side="' + side + '">Voted</button>'
          : '<button class="vote-btn cast h2h-vote-btn" data-action="vote" data-side="' + side + '">Vote</button>';
        if (!state.anonymous) body += '<div class="h2h-count">' + v.count + " vote" + (v.count !== 1 ? "s" : "") + "</div>";
        if (!isGuest) {
          body += '<div class="others-row" style="margin-top:8px;"><span>Others</span><div class="stepper">' +
            '<button class="icon-btn small" data-action="others-minus" data-side="' + side + '">&minus;</button>' +
            "<span>" + v.manual + "</span>" +
            '<button class="icon-btn small" data-action="others-plus" data-side="' + side + '">+</button>' +
            "</div></div>";
        }
      }
      var winnerBadge = (m.winner && m.winner !== "BYE" && m.winner.id === comp.id) ? '<div class="h2h-winner">Winner</div>' : "";
      return '<div class="h2h-side">' +
        '<div class="h2h-avatar">' + avatarInnerHTML(comp) + "</div>" +
        '<div class="h2h-name-row"><span class="h2h-name">' + esc(comp.name) + '</span>' +
        '<button class="info-btn h2h-info-btn" data-action="view-details" data-comp-id="' + comp.id + '" aria-label="View ' + esc(comp.name) + ' details">i</button></div>' +
        '<div class="h2h-by">' + (comp.by ? esc(comp.by) : "&nbsp;") + "</div>" +
        body + winnerBadge +
        "</div>";
    }

    var html = '<div class="h2h">' + sideHTML("a") + '<div class="h2h-vs">vs</div>' + sideHTML("b") + "</div>";

    var bothReal = m.a && m.b && m.a !== "BYE" && m.b !== "BYE";
    if (bothReal && !isGuest && state.locked) {
      var isFocused = state.focusedMatch && state.focusedMatch.round === round && state.focusedMatch.idx === idx;
      html += isFocused
        ? '<div class="focus-control"><span class="focus-active-badge">&#9733; Current head-to-head</span><button class="text-link-btn" data-action="clear-focus">Clear</button></div>'
        : '<button class="vote-btn remove set-focus-btn" data-action="set-focus">Set as current head-to-head</button>';
    }

    if (bothReal) {
      if (!state.locked) {
        html += '<div class="vote-locked-hint" style="justify-content:center;margin-top:10px;">Lock the configuration to start voting</div>';
      } else {
        var total = totalVotesFor(round, idx);
        var fully = isFullyVoted(round, idx);
        var revealed = isRevealed(round, idx);
        var tied = revealed && !m.winner;

        if (!revealed) {
          if (state.anonymous) {
            html += '<div class="h2h-status">' + total + " of " + state.tasters + " tasters have voted</div>";
            if (!isGuest) {
              html += fully
                ? '<button class="vote-btn cast" data-action="reveal">Reveal result</button>'
                : '<div class="vote-locked-hint" style="justify-content:center;">Votes stay hidden until everyone has voted</div>';
            } else if (fully) {
              html += '<div class="vote-locked-hint" style="justify-content:center;">Waiting for the host to reveal the result</div>';
            }
          } else {
            html += '<div class="h2h-status">' + total + " vote" + (total !== 1 ? "s" : "") + " so far</div>";
            if (!isGuest) {
              html += '<button class="vote-btn cast" data-action="reveal">Lock in this round</button>';
            } else {
              html += '<div class="vote-locked-hint" style="justify-content:center;">You can change your vote until the host locks in this round</div>';
            }
          }
        } else if (tied) {
          if (isGuest) {
            html += '<div class="tie-panel"><div class="vote-locked-hint" style="justify-content:center;">Tied — waiting for the host to resolve it</div></div>';
          } else {
            html += '<div class="tie-panel">' +
              '<div class="vote-locked-hint" style="justify-content:center;">Tied — pick how to resolve it</div>' +
              '<button class="vote-btn remove" data-action="revote">Revote</button>' +
              '<button class="vote-btn cast" data-action="declare-a">Declare ' + esc(m.a.name) + " winner</button>" +
              '<button class="vote-btn cast" data-action="declare-b">Declare ' + esc(m.b.name) + " winner</button>" +
              "</div>";
          }
        } else {
          html += '<div class="h2h-status h2h-winner">' + esc(m.winner.name) + " wins this round</div>";
        }
      }
    } else if (m.a === "BYE" || m.b === "BYE") {
      html += '<div class="h2h-status">Bye — advances automatically</div>';
    } else {
      html += '<div class="h2h-status">Waiting for both wines to be known</div>';
    }

    return html;
  }

  function wireHeadToHead(container, round, idx) {
    function act(selector, handler) {
      Array.prototype.forEach.call(container.querySelectorAll(selector), function (el) {
        el.addEventListener("click", function () {
          if (!state.locked) return;
          handler(this.getAttribute("data-side"));
        });
      });
    }
    act('[data-action="vote"]', function (side) { doAction("vote", round, idx, side); });
    act('[data-action="unvote"]', function (side) { doAction("unvote", round, idx, side); });
    act('[data-action="others-plus"]', function (side) {
      var v = getVote(round, idx, side);
      doManual(round, idx, side, v.manual + 1);
    });
    act('[data-action="others-minus"]', function (side) {
      var v = getVote(round, idx, side);
      doManual(round, idx, side, v.manual - 1);
    });
    act('[data-action="reveal"]', function () { if (!isGuest) doAction("reveal", round, idx, null); });
    act('[data-action="revote"]', function () { if (!isGuest) doAction("revote", round, idx, null); });
    act('[data-action="declare-a"]', function () { if (!isGuest) doAction("declare-a", round, idx, null); });
    act('[data-action="declare-b"]', function () { if (!isGuest) doAction("declare-b", round, idx, null); });

    var setFocusBtn = container.querySelector('[data-action="set-focus"]');
    if (setFocusBtn) setFocusBtn.addEventListener("click", function () {
      if (isGuest) return;
      state.focusedMatch = { round: round, idx: idx };
      saveState();
      showFocusPanel = true;
      renderAll();
      refreshOpenCards();
      broadcastState();
    });
    var clearFocusBtn = container.querySelector('[data-action="clear-focus"]');
    if (clearFocusBtn) clearFocusBtn.addEventListener("click", function () {
      if (isGuest) return;
      state.focusedMatch = null;
      saveState();
      renderAll();
      refreshOpenCards();
      broadcastState();
    });
    Array.prototype.forEach.call(container.querySelectorAll('[data-action="view-details"]'), function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var compId = Number(this.getAttribute("data-comp-id"));
        withTransition(function () { openEditModal(compId, { round: round, idx: idx }); });
      });
    });
  }

  function renderFocusPanel() {
    var has = !!state.focusedMatch;
    els.focusToggle.hidden = !has;
    if (has) els.focusToggle.setAttribute("aria-pressed", String(showFocusPanel));
    if (!has || !showFocusPanel) {
      els.focusPanel.hidden = true;
      return;
    }
    els.focusPanel.hidden = false;
    els.focusPanel.innerHTML = '<div class="focus-panel-label">Current head-to-head</div>' + headToHeadHTML(state.focusedMatch.round, state.focusedMatch.idx);
    wireHeadToHead(els.focusPanel, state.focusedMatch.round, state.focusedMatch.idx);
  }

  function refreshOpenCards() {
    if (modalKind === "h2h" && modalMatch && !els.modal.hidden) {
      els.modalBody.innerHTML = headToHeadHTML(modalMatch.round, modalMatch.idx);
      wireHeadToHead(els.modalBody, modalMatch.round, modalMatch.idx);
    }
    renderFocusPanel();
    renderThirdPlacePanel();
  }

  function renderThirdPlacePanel() {
    var data = buildData();
    if (!state.locked || !data || !data.thirdPlace || !data.thirdPlace.a || !data.thirdPlace.b) {
      els.thirdPlacePanel.hidden = true;
      return;
    }
    els.thirdPlacePanel.hidden = false;
    els.thirdPlacePanel.innerHTML = '<div class="focus-panel-label">3rd place play-off</div>' + headToHeadHTML("T", 0);
    wireHeadToHead(els.thirdPlacePanel, "T", 0);
  }

  function renderPodium(data, championComp) {
    if (!championComp) { els.podium.hidden = true; return; }
    var runnerUp = data.runnerUp;
    var third = data.thirdPlace && data.thirdPlace.winner;
    els.podium.hidden = false;
    function slot(rank, comp, label) {
      if (!comp) return '<div class="podium-slot podium-empty podium-rank-' + rank + '"><div class="podium-place">' + label + '</div><div class="podium-tbd">TBD</div></div>';
      return '<div class="podium-slot podium-rank-' + rank + '">' +
        '<div class="podium-avatar">' + avatarInnerHTML(comp) + "</div>" +
        '<div class="podium-place">' + label + '</div>' +
        '<div class="podium-name">' + esc(comp.name) + "</div>" +
        "</div>";
    }
    els.podium.innerHTML =
      '<div class="podium-title">Podium</div>' +
      '<div class="podium-row">' +
      slot(2, runnerUp, "2nd") +
      slot(1, championComp, "1st") +
      slot(3, third, "3rd") +
      "</div>";
  }

  // ---------- edit card (pre-lock) ----------

  function editCardHTML(c) {
    var locked = state.locked;
    return '<div class="modal-photo-row">' +
      '<input type="file" accept="image/*" id="ecImgInput" hidden />' +
      '<button type="button" id="ecPhotoBtn" class="modal-photo-btn" aria-label="Change photo">' + avatarInnerHTML(c) + "</button>" +
      '<div class="modal-fields">' +
      '<input id="ecName" placeholder="Wine name" value="' + esc(c.name) + '"' + (locked ? " disabled" : "") + " />" +
      '<input id="ecBy" placeholder="Brought by" value="' + esc(c.by || "") + '"' + (locked ? " disabled" : "") + " />" +
      "</div></div>" +
      '<textarea id="ecDesc" placeholder="Tasting notes..."' + (locked ? " disabled" : "") + ">" + esc(c.desc || "") + "</textarea>" +
      (locked ? "" : '<button id="ecRemove" class="text-danger-btn">Remove this wine</button>');
  }

  function wireEditCard(container, compId) {
    function findComp() { return state.competitors.find(function (x) { return x.id === compId; }); }
    var nameEl = container.querySelector("#ecName");
    var byEl = container.querySelector("#ecBy");
    var descEl = container.querySelector("#ecDesc");
    var photoBtn = container.querySelector("#ecPhotoBtn");
    var imgInput = container.querySelector("#ecImgInput");
    var removeBtn = container.querySelector("#ecRemove");

    if (nameEl) nameEl.addEventListener("input", function () {
      if (state.locked) return;
      var c = findComp(); if (c) { c.name = this.value; saveState(); renderAll(); }
    });
    if (byEl) byEl.addEventListener("input", function () {
      if (state.locked) return;
      var c = findComp(); if (c) { c.by = this.value; saveState(); renderAll(); }
    });
    if (descEl) descEl.addEventListener("input", function () {
      if (state.locked) return;
      var c = findComp(); if (c) { c.desc = this.value; saveState(); }
    });
    if (photoBtn) photoBtn.addEventListener("click", function () {
      if (state.locked) return;
      imgInput.click();
    });
    if (imgInput) imgInput.addEventListener("change", function (e) {
      if (state.locked) return;
      var file = e.target.files[0];
      if (!file) return;
      compressImage(file).then(function (dataUrl) {
        var c = findComp();
        if (c) { c.img = dataUrl; photoBtn.innerHTML = avatarInnerHTML(c); saveState(); renderAll(); }
      });
    });
    if (removeBtn) removeBtn.addEventListener("click", function () {
      if (state.locked) return;
      state.competitors = state.competitors.filter(function (c) { return c.id !== compId; });
      resetBracketState();
      saveState();
      closeModal();
      renderAll();
    });
  }

  // ---------- modal ----------

  function openEditModal(compId, returnTo) {
    var c = state.competitors.find(function (x) { return x.id === compId; });
    if (!c) return;
    modalKind = "edit";
    modalCompId = compId;
    modalMatch = null;
    modalReturnTo = returnTo || null;
    els.modalBack.hidden = !modalReturnTo;
    els.modalTitle.textContent = "Wine details";
    els.modalBody.innerHTML = editCardHTML(c);
    wireEditCard(els.modalBody, compId);
    els.modal.hidden = false;
    els.backdrop.hidden = false;
  }

  function openHeadToHeadModal(round, idx) {
    modalKind = "h2h";
    modalMatch = { round: round, idx: idx };
    modalCompId = null;
    modalReturnTo = null;
    els.modalBack.hidden = true;
    els.modalTitle.textContent = "Head to head";
    els.modalBody.innerHTML = headToHeadHTML(round, idx);
    wireHeadToHead(els.modalBody, round, idx);
    els.modal.hidden = false;
    els.backdrop.hidden = false;
  }

  function closeModal() {
    els.modal.hidden = true;
    els.backdrop.hidden = true;
    modalKind = null;
    modalCompId = null;
    modalMatch = null;
    modalReturnTo = null;
  }

  // ---------- events ----------

  function wireEvents() {
    els.modalClose.addEventListener("click", closeModal);
    els.backdrop.addEventListener("click", closeModal);
    els.modalBack.addEventListener("click", function () {
      if (!modalReturnTo) return;
      var target = modalReturnTo;
      withTransition(function () { openHeadToHeadModal(target.round, target.idx); });
    });

    els.wineToggle.addEventListener("click", function () {
      if (state.locked) return;
      formOpen = !formOpen;
      els.winePanel.hidden = !formOpen;
      els.wineToggle.setAttribute("aria-expanded", String(formOpen));
    });
    els.photoBtn.addEventListener("click", function () { els.wimg.click(); });
    els.wimg.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      compressImage(file).then(function (dataUrl) {
        pendingImg = dataUrl;
        els.photoBtn.innerHTML = '<img src="' + dataUrl + '" style="width:100%;height:100%;object-fit:cover;" alt="" />';
      });
    });
    els.addBtn.addEventListener("click", function () {
      if (state.locked) return;
      var name = els.wname.value.trim();
      if (!name) return;
      state.competitors.push({
        id: state.nextId++,
        name: name,
        by: els.wby.value.trim(),
        img: pendingImg,
        desc: els.wdesc.value.trim()
      });
      els.wname.value = ""; els.wby.value = ""; els.wdesc.value = ""; pendingImg = null;
      els.photoBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="13" r="3.5"/></svg>';
      resetBracketState();
      saveState();
      renderAll();
      els.wname.focus();
    });

    els.tMinus.addEventListener("click", function () {
      if (state.locked) return;
      state.tasters = Math.max(1, state.tasters - 1);
      els.tVal.textContent = state.tasters;
      saveState();
      renderBracket();
    });
    els.tPlus.addEventListener("click", function () {
      if (state.locked) return;
      state.tasters = Math.min(30, state.tasters + 1);
      els.tVal.textContent = state.tasters;
      saveState();
      renderBracket();
    });

    els.anonInfoBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = els.anonTooltip.hidden;
      els.anonTooltip.hidden = !open;
      els.anonInfoBtn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) {
      if (!els.anonTooltip.hidden && !els.anonTooltip.contains(e.target) && e.target !== els.anonInfoBtn) {
        els.anonTooltip.hidden = true;
        els.anonInfoBtn.setAttribute("aria-expanded", "false");
      }
    });

    els.anonToggle.addEventListener("click", function () {
      if (isGuest) return;
      if (!state.anonymous) {
        var before = buildData();
        if (before) {
          before.rounds.forEach(function (roundMatches, r) {
            roundMatches.forEach(function (m, i) {
              if (m.winner) state.revealed[matchKey(r, i)] = true;
            });
          });
          if (before.thirdPlace && before.thirdPlace.winner) state.revealed[matchKey("T", 0)] = true;
        }
      }
      state.anonymous = !state.anonymous;
      saveState();
      renderAll();
      refreshOpenCards();
      broadcastState();
    });

    els.focusToggle.addEventListener("click", function () {
      showFocusPanel = !showFocusPanel;
      renderFocusPanel();
    });

    els.lockBtn.addEventListener("click", function () {
      if (state.locked) {
        if (!confirm("Unlock configuration? This will reset all votes and end any active voting session.")) return;
        state.locked = false;
        state.votes = {};
        state.focusedMatch = null;
        closeModal();
        stopSession();
      } else {
        state.locked = true;
      }
      saveState();
      renderAll();
    });

    els.menuBtn.addEventListener("click", function () {
      var open = els.menuPanel.hidden;
      els.menuPanel.hidden = !open;
      els.menuBtn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) {
      if (!els.menuPanel.hidden && !els.menuPanel.contains(e.target) && e.target !== els.menuBtn && !els.menuBtn.contains(e.target)) {
        els.menuPanel.hidden = true;
        els.menuBtn.setAttribute("aria-expanded", "false");
      }
    });

    els.exportBtn.addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "poor-taste-backup.json";
      a.click();
      URL.revokeObjectURL(url);
      els.menuPanel.hidden = true;
    });
    els.importBtn.addEventListener("click", function () {
      els.importInput.click();
      els.menuPanel.hidden = true;
    });
    els.importInput.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          state = Object.assign(JSON.parse(JSON.stringify(defaultState)), parsed);
          saveState();
          els.tVal.textContent = state.tasters;
          renderAll();
        } catch (err) {
          alert("That file doesn't look like a valid backup.");
        }
      };
      reader.readAsText(file);
      els.importInput.value = "";
    });
    els.resetBtn.addEventListener("click", function () {
      if (!confirm("Reset everything? This clears all wines and votes on this device.")) return;
      stopSession();
      state = JSON.parse(JSON.stringify(defaultState));
      saveState();
      els.tVal.textContent = state.tasters;
      renderAll();
      els.menuPanel.hidden = true;
    });

    els.startSessionBtn.addEventListener("click", startSession);
    els.stopSessionBtn.addEventListener("click", stopSession);
    els.copyLinkBtn.addEventListener("click", function () {
      var url = this.dataset.url;
      if (!url) return;
      navigator.clipboard.writeText(url).then(function () {
        els.copyLinkBtn.textContent = "Copied!";
        setTimeout(function () { els.copyLinkBtn.textContent = "Copy link instead"; }, 1500);
      });
    });
    els.sessionDetailsToggle.addEventListener("click", function () {
      var open = els.sessionDetails.hidden;
      els.sessionDetails.hidden = !open;
      els.sessionDetailsToggle.setAttribute("aria-expanded", String(open));
    });

    els.joinByCodeBtn.addEventListener("click", function () {
      var open = els.joinByCodeForm.hidden;
      els.joinByCodeForm.hidden = !open;
      if (open) els.joinCodeInput.focus();
    });
    els.joinByCodeSubmit.addEventListener("click", function () {
      var code = els.joinCodeInput.value.trim();
      if (!code) return;
      location.href = location.pathname + "?join=" + encodeURIComponent(code);
    });
    els.joinCodeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") els.joinByCodeSubmit.click();
    });

    els.joinBtn.addEventListener("click", function () {
      var name = els.joinName.value.trim();
      if (!name) { els.joinStatus.textContent = "Enter your name to join."; els.joinStatus.className = "join-status error"; return; }
      localStorage.setItem(GUEST_NAME_KEY, name);
      els.joinScreen.hidden = true;
      els.mainApp.hidden = false;
      setConnectionStatus("", "Connecting…");
      joinSession(joinId, name);
    });
    els.joinHomeBtn.addEventListener("click", function () { location.href = location.pathname; });
    els.connectionHomeBtn.addEventListener("click", function () { location.href = location.pathname; });
  }

  // ---------- init ----------

  document.addEventListener("DOMContentLoaded", function () {
    cacheEls();
    wireEvents();

    if (isGuest) {
      document.body.classList.add("guest-mode");
      var savedName = localStorage.getItem(GUEST_NAME_KEY);
      if (savedName) {
        els.mainApp.hidden = false;
        els.joinScreen.hidden = true;
        setConnectionStatus("", "Connecting…");
        joinSession(joinId, savedName);
      } else {
        els.mainApp.hidden = true;
        els.joinScreen.hidden = false;
        els.joinName.focus();
      }
    } else {
      els.tVal.textContent = state.tasters;
      renderAll();
      if (state.locked && localStorage.getItem(SESSION_CODE_KEY)) startSession(true);
    }
  });
})();
