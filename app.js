(function () {
  "use strict";

  var STORAGE_KEY = "poor-taste-state-v1";
  var CX = 500, CY = 500, OUTER = 430;
  var LEVEL_PCT = [9.5, 8, 7, 6.5, 6];

  var defaultState = {
    tasters: 4,
    locked: false,
    competitors: [],
    nextId: 1,
    votes: {},
    showPicks: false
  };

  var state = loadState();

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

  function votesNeeded() { return Math.floor(state.tasters / 2) + 1; }
  function voteKey(r, i, side) { return r + "-" + i + "-" + side; }
  function getVote(r, i, side) {
    var v = state.votes[voteKey(r, i, side)] || {};
    var yourVote = !!v.yourVote;
    var others = v.others || 0;
    return { yourVote: yourVote, others: others, count: (yourVote ? 1 : 0) + others };
  }
  function setYourVote(r, i, side, yourVote) {
    var key = voteKey(r, i, side);
    var v = state.votes[key] || { yourVote: false, others: 0 };
    state.votes[key] = { yourVote: yourVote, others: v.others };
  }
  function setOthers(r, i, side, others) {
    var key = voteKey(r, i, side);
    var v = state.votes[key] || { yourVote: false, others: 0 };
    state.votes[key] = { yourVote: v.yourVote, others: Math.max(0, others) };
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
        var va = getVote(r, i, "a").count, vb = getVote(r, i, "b").count;
        if (va >= needed) m.winner = m.a; else if (vb >= needed) m.winner = m.b;
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
    return { size: size, R: R, rounds: rounds, needed: needed, slots: slots, slotIndex: slotIndex, leafAngle: leafAngle, matchAngle: matchAngle, ECHO_R: ECHO_R };
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

  function isYourPick(si, k, roundsWon, R) {
    if (k > 0) {
      var idxPrev = idxAt(si, k - 1), sidePrev = sideAt(si, k - 1);
      if (getVote(k - 1, idxPrev, sidePrev).yourVote) return true;
    }
    if (k === roundsWon && roundsWon < R) {
      var idxCur = idxAt(si, roundsWon), sideCur = sideAt(si, roundsWon);
      if (getVote(roundsWon, idxCur, sideCur).yourVote) return true;
    }
    return false;
  }

  // ---------- rendering ----------

  var els = {};
  function cacheEls() {
    [
      "svgLayer", "avatarLayer", "bracketWrap", "statLine", "chips", "wineToggle", "wineToggleLabel",
      "wineToggleIcon", "winePanel", "manageBlock", "lockedNote", "lockBtn", "lockIconOpen", "lockIconClosed",
      "tVal", "tMinus", "tPlus", "picksToggle", "modal", "backdrop", "modalName", "modalBy", "modalDesc",
      "modalPhotoBtn", "modalImgInput", "modalStatus", "modalVoteSection", "modalRemove", "modalClose",
      "wname", "wby", "wdesc", "wimg", "photoBtn", "addBtn", "menuBtn", "menuPanel", "exportBtn",
      "importBtn", "importInput", "resetBtn"
    ].forEach(function (id) { els[id] = document.getElementById(id); });
  }

  var pendingImg = null;
  var formOpen = false;
  var modalCompId = null;

  function renderAll() {
    renderChips();
    renderBracket();
    renderLockUI();
  }

  function renderChips() {
    els.chips.innerHTML = state.competitors.map(function (c) {
      return (
        '<div class="chip">' +
        '<span class="chip-avatar">' + avatarInnerHTML(c) + "</span>" +
        "<span>" + esc(c.name) + (c.by ? '<span class="by"> &middot; ' + esc(c.by) + "</span>" : "") + "</span>" +
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
        state.votes = {};
        saveState();
        renderAll();
      });
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

    var lineOpacity = state.showPicks ? "0.15" : "1";
    var svgPaths = "", svgDots = "";
    for (var r = 0; r < data.R; r++) {
      for (var i = 0; i < data.rounds[r].length; i++) {
        svgPaths += '<path d="' + connectorPath(data, r, i) + '" fill="none" stroke="var(--line)" stroke-opacity="0.5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
        if (!data.rounds[r][i].winner) {
          var p = pt(data.ECHO_R[r + 1], data.matchAngle[r][i]);
          svgDots += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="var(--muted)"/>';
        }
      }
    }
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
        var pct = isChamp ? 13 : LEVEL_PCT[Math.min(k, 4)];
        var border = "2px solid var(--border)";
        var faded = "";
        var badge = "";
        if (isChamp) {
          border = "3px solid var(--gold)";
        } else if (isFrontier && st.eliminated) {
          faded = "filter:grayscale(0.75);";
        } else if (isFrontier && st.roundsWon < data.R) {
          var idx = idxAt(si, st.roundsWon), side = sideAt(si, st.roundsWon);
          var m = data.rounds[st.roundsWon][idx];
          var reachable = m.a && m.b && m.a !== "BYE" && m.b !== "BYE" && !m.winner;
          if (reachable) {
            var v = getVote(st.roundsWon, idx, side);
            border = v.yourVote ? "3px solid var(--accent)" : "2px solid var(--border)";
            if (v.count > 0) badge = '<span class="avatar-badge">' + v.count + "</span>";
          }
        }
        if (state.showPicks) {
          var pick = isYourPick(si, k, st.roundsWon, data.R);
          if (!pick) faded += "opacity:0.25;";
          else if (!isChamp) border = "3px solid var(--accent)";
        }
        avatars +=
          '<div class="avatar" data-comp="' + c.id + '" style="left:' + p[0] / 10 + "%;top:" + p[1] / 10 + "%;width:" + pct + "%;height:" + pct + "%;" + faded + '">' +
          '<div class="avatar-inner" style="border:' + border + ';">' + avatarInnerHTML(c) + "</div>" +
          badge + "</div>";
      }
    });

    var center = championComp
      ? '<div class="champion-banner"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 21h8M12 17v4M5 4h14l-1 5a6 6 0 0 1-12 0L5 4z"/><path d="M5 4H3a2 2 0 0 0 0 4M19 4h2a2 2 0 0 1 0 4"/></svg><span>' + esc(championComp.name) + "</span></div>"
      : '<div class="trophy-empty"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 21h8M12 17v4M5 4h14l-1 5a6 6 0 0 1-12 0L5 4z"/><path d="M5 4H3a2 2 0 0 0 0 4M19 4h2a2 2 0 0 1 0 4"/></svg></div>';

    els.avatarLayer.innerHTML = avatars + center;
    Array.prototype.forEach.call(els.avatarLayer.querySelectorAll("[data-comp]"), function (el) {
      el.addEventListener("click", function () { openModalFor(Number(this.getAttribute("data-comp"))); });
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
  }

  // ---------- modal ----------

  function openModalFor(id) {
    modalCompId = id;
    var c = state.competitors.find(function (x) { return x.id === id; });
    if (!c) return;
    els.modalName.value = c.name;
    els.modalBy.value = c.by || "";
    els.modalDesc.value = c.desc || "";
    els.modalName.disabled = els.modalBy.disabled = els.modalDesc.disabled = state.locked;
    els.modalPhotoBtn.innerHTML = avatarInnerHTML(c);
    els.modal.hidden = false;
    els.backdrop.hidden = false;
    renderModalComputed();
  }

  function closeModal() {
    els.modal.hidden = true;
    els.backdrop.hidden = true;
    modalCompId = null;
  }

  function renderModalComputed() {
    var c = state.competitors.find(function (x) { return x.id === modalCompId; });
    if (!c) { els.modalStatus.innerHTML = ""; els.modalVoteSection.innerHTML = ""; return; }
    var data = buildData();
    var si = data.slotIndex[c.id];
    if (si === undefined) { els.modalStatus.innerHTML = ""; els.modalVoteSection.innerHTML = ""; return; }
    var st = statusFor(data, si, c.id);

    if (st.roundsWon === data.R) {
      els.modalStatus.innerHTML = "\u{1F3C6} Champion";
      els.modalVoteSection.innerHTML = "";
      return;
    }
    if (st.eliminated) {
      els.modalStatus.textContent = "Eliminated";
      els.modalVoteSection.innerHTML = "";
      return;
    }
    var idx = idxAt(si, st.roundsWon), side = sideAt(si, st.roundsWon);
    var m = data.rounds[st.roundsWon][idx];
    var opponent = side === "a" ? m.b : m.a;
    if (!opponent) {
      els.modalStatus.textContent = "Waiting for an opponent";
      els.modalVoteSection.innerHTML = "";
      return;
    }
    els.modalStatus.textContent = "Facing " + opponent.name;

    if (!state.locked) {
      els.modalVoteSection.innerHTML = '<div class="vote-locked-hint">Lock the configuration to start voting</div>';
      return;
    }

    var v = getVote(st.roundsWon, idx, side);
    var pct = Math.min(100, Math.round((v.count / data.needed) * 100));
    var html =
      '<div style="font-size:12px;margin-bottom:4px;">' + v.count + " of " + data.needed + " votes to advance</div>" +
      '<div class="vote-progress"><div class="vote-progress-fill" style="width:' + pct + '%;"></div></div>';
    html += v.yourVote
      ? '<button class="vote-btn remove" data-action="unvote">Remove your vote</button>'
      : '<button class="vote-btn cast" data-action="vote">Vote for this wine</button>';
    html +=
      '<div class="others-row">' +
      '<span>Other tasters</span>' +
      '<div class="stepper">' +
      '<button class="icon-btn small" data-action="others-minus" aria-label="Fewer other votes">&minus;</button>' +
      '<span>' + v.others + '</span>' +
      '<button class="icon-btn small" data-action="others-plus" aria-label="More other votes">+</button>' +
      '</div></div>';
    els.modalVoteSection.innerHTML = html;

    var voteBtn = els.modalVoteSection.querySelector('[data-action="vote"]');
    if (voteBtn) voteBtn.addEventListener("click", function () {
      if (!state.locked) return;
      setYourVote(st.roundsWon, idx, side, true);
      saveState();
      renderAll();
      renderModalComputed();
    });
    var unvoteBtn = els.modalVoteSection.querySelector('[data-action="unvote"]');
    if (unvoteBtn) unvoteBtn.addEventListener("click", function () {
      if (!state.locked) return;
      setYourVote(st.roundsWon, idx, side, false);
      saveState();
      renderAll();
      renderModalComputed();
    });
    var othersMinus = els.modalVoteSection.querySelector('[data-action="others-minus"]');
    othersMinus.addEventListener("click", function () {
      if (!state.locked) return;
      setOthers(st.roundsWon, idx, side, v.others - 1);
      saveState();
      renderAll();
      renderModalComputed();
    });
    var othersPlus = els.modalVoteSection.querySelector('[data-action="others-plus"]');
    othersPlus.addEventListener("click", function () {
      if (!state.locked) return;
      setOthers(st.roundsWon, idx, side, v.others + 1);
      saveState();
      renderAll();
      renderModalComputed();
    });
  }

  // ---------- events ----------

  function wireEvents() {
    els.modalClose.addEventListener("click", closeModal);
    els.backdrop.addEventListener("click", closeModal);

    els.modalName.addEventListener("input", function () {
      if (state.locked) return;
      var c = state.competitors.find(function (x) { return x.id === modalCompId; });
      if (c) { c.name = this.value; saveState(); renderAll(); }
    });
    els.modalBy.addEventListener("input", function () {
      if (state.locked) return;
      var c = state.competitors.find(function (x) { return x.id === modalCompId; });
      if (c) { c.by = this.value; saveState(); renderAll(); }
    });
    els.modalDesc.addEventListener("input", function () {
      if (state.locked) return;
      var c = state.competitors.find(function (x) { return x.id === modalCompId; });
      if (c) { c.desc = this.value; saveState(); }
    });
    els.modalPhotoBtn.addEventListener("click", function () {
      if (state.locked) return;
      els.modalImgInput.click();
    });
    els.modalImgInput.addEventListener("change", function (e) {
      if (state.locked) return;
      var file = e.target.files[0];
      if (!file) return;
      compressImage(file).then(function (dataUrl) {
        var c = state.competitors.find(function (x) { return x.id === modalCompId; });
        if (c) { c.img = dataUrl; els.modalPhotoBtn.innerHTML = avatarInnerHTML(c); saveState(); renderAll(); }
      });
    });
    els.modalRemove.addEventListener("click", function () {
      if (state.locked || modalCompId == null) return;
      state.competitors = state.competitors.filter(function (c) { return c.id !== modalCompId; });
      state.votes = {};
      saveState();
      closeModal();
      renderAll();
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
      state.votes = {};
      saveState();
      renderAll();
      formOpen = false;
      els.winePanel.hidden = true;
      els.wineToggle.setAttribute("aria-expanded", "false");
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

    els.picksToggle.addEventListener("click", function () {
      state.showPicks = !state.showPicks;
      els.picksToggle.setAttribute("aria-pressed", String(state.showPicks));
      renderBracket();
    });

    els.lockBtn.addEventListener("click", function () {
      if (state.locked) {
        state.locked = false;
        state.votes = {};
        closeModal();
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
      state = JSON.parse(JSON.stringify(defaultState));
      saveState();
      els.tVal.textContent = state.tasters;
      renderAll();
      els.menuPanel.hidden = true;
    });
  }

  // ---------- init ----------

  document.addEventListener("DOMContentLoaded", function () {
    cacheEls();
    wireEvents();
    els.tVal.textContent = state.tasters;
    renderAll();
  });
})();
