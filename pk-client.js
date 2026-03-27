/**
 * pk-client.js  –  PluralKit relay client
 *
 * Drop-in replacement for octo-client.js.
 * Exposes the same two global functions:
 *
 *   window.getCurrentFronters(elementId)
 *   window.getLastFrontedDateTime(elementId, memberId)
 *
 * NOTE: memberId must now be a PluralKit member UUID (the long form, e.g.
 * "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), NOT an Octocon alter ID.
 * You can find a member's UUID via `pk;member <name>` or the PK dashboard.
 *
 * Just swap RELAY_URL to point at your pk-relay instance.
 */

(() => {
  const RELAY_URL = 'wss://YOUR_RELAY_IP_HERE';

  // ─── internal state ────────────────────────────────────────────────────────

  let socket = null;
  let ready = false;
  let currentFronts = [];         // wrapped front objects from relay
  let lastFrontedHistory = {};    // memberUuid → ISO timestamp string
  let historyLoaded = false;

  // Registered targets for live-ticking "last fronted" displays
  // { memberId: string, elementId: string }
  const lastFrontedTargets = [];

  // ─── helpers ───────────────────────────────────────────────────────────────

  function timeSince(ts) {
    const then = typeof ts === 'number' ? ts : new Date(ts).getTime();
    const diffMs = Date.now() - then;
    if (diffMs < 0) return 'in the future?';

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30.4375);
    const years = Math.floor(months / 12);

    const plural = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
    const parts = [];

    if (years > 0) {
      parts.push(plural(years, 'year'));
      const rem = months % 12;
      if (rem > 0) parts.push(plural(rem, 'month'));
    } else if (months > 0) {
      parts.push(plural(months, 'month'));
      const rem = Math.floor(days % 30.4375);
      if (rem > 0) parts.push(plural(rem, 'day'));
    } else if (days > 0) {
      parts.push(plural(days, 'day'));
      const rem = hours % 24;
      if (rem > 0) parts.push(plural(rem, 'hour'));
    } else if (hours > 0) {
      parts.push(plural(hours, 'hour'));
      const rem = minutes % 60;
      if (rem > 0) parts.push(plural(rem, 'minute'));
    } else if (minutes > 0) {
      parts.push(plural(minutes, 'minute'));
      const rem = seconds % 60;
      if (rem > 0) parts.push(plural(rem, 'second'));
    } else {
      parts.push(plural(seconds, 'second'));
    }

    return parts.slice(0, 2).join(', ') + ' ago';
  }

  function setHTML(el, html) {
    if (el.dataset.lastValue !== html) {
      el.dataset.lastValue = html;
      el.innerHTML = html;
    }
  }

  // ─── WebSocket connection ──────────────────────────────────────────────────

  function connect() {
    socket = new WebSocket(RELAY_URL);

    socket.addEventListener('open', () => {
      ready = true;
      // pk-relay sends a snapshot automatically on connect, but request
      // explicitly in case of a race or reconnect after reload.
      socket.send(JSON.stringify({ event: 'get_current_fronts' }));
      socket.send(JSON.stringify({ event: 'get_last_fronted_all' }));
    });

    socket.addEventListener('message', ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      handleMessage(msg);
    });

    socket.addEventListener('close', () => {
      ready = false;
      setTimeout(connect, 3000);
    });

    socket.addEventListener('error', () => { });
  }

  function handleMessage(msg) {
    switch (msg.event) {

      // ── snapshot (sent on connect and on every switch change) ───────────
      case 'fronts_snapshot':
      case 'current_fronts':
        currentFronts = msg.fronts || [];
        refreshFrontersElements();
        refreshLastFrontedElements();
        break;

      // ── last-fronted history ─────────────────────────────────────────────
      case 'last_fronted_all':
        lastFrontedHistory = msg.history || {};
        historyLoaded = true;
        refreshLastFrontedElements();
        break;

      // ── granular events (relay may emit these in future versions) ────────
      case 'fronting_started':
        if (msg.payload?.front) {
          currentFronts.push(msg.payload.front);
          refreshFrontersElements();
          refreshLastFrontedElements();
        }
        break;

      case 'fronting_ended':
        if (msg.payload?.member_id) {
          currentFronts = currentFronts.filter(
            f => f.alter?.id !== msg.payload.member_id
          );
          refreshFrontersElements();
          refreshLastFrontedElements();
        }
        break;

      case 'last_fronted_update':
        if (msg.member_id && msg.timestamp) {
          lastFrontedHistory[String(msg.member_id)] = msg.timestamp;
          refreshLastFrontedElements();
        }
        break;
    }
  }

  // ─── fronters element registry ────────────────────────────────────────────

  const frontersTargets = [];

  function refreshFrontersElements() {
    for (const { elementId } of frontersTargets) renderFronters(elementId);
  }

  function renderFronters(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const visible = currentFronts.filter(
      f => f.alter?.security_level !== 'private'
    );

    if (!visible.length) {
      setHTML(el, '<span class="p"><strong>No one is currently fronting.</strong></span>');
      return;
    }

    const names = visible
      .map(f => {
        const a = f.alter;
        if (!a) return null;

        const safe = (a.name || '').replace(/\s+/g, '-');
        let label = `<a href="#${safe}" style="color:${a.color};text-decoration:none;">${a.name}</a>`;

        const comment = f.front?.comment;
        const commentStr = (typeof comment === 'string') ? comment.trim() : '';

        if (commentStr) {
          label += ` <span style="color:${a.color};">(${commentStr})</span>`;
        }

        return label;
      })
      .filter(Boolean)
      .join(', ');

    setHTML(el, `<span class="p"><strong>Currently Fronting:</strong> ${names}</span>`);
  }

  // ─── last-fronted element registry ────────────────────────────────────────

  function refreshLastFrontedElements() {
    if (!historyLoaded) return;
    for (const { memberId, elementId } of lastFrontedTargets) {
      renderLastFronted(memberId, elementId);
    }
  }

  function renderLastFronted(memberId, elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const key = String(memberId);
    const isFronting = currentFronts.some(f => f.alter?.id === key);

    if (isFronting) {
      setHTML(el, `<span class="p"><strong>Last Fronted:&nbsp;<rainbow class="pulse">Actively Fronting Now!</rainbow></strong></span>`);
      return;
    }

    const ts = lastFrontedHistory[key];

    if (!ts) {
      setHTML(el, `<span class="p"><strong>Last Fronted:</strong> Unknown</span>`);
      return;
    }

    setHTML(el, `<span class="p"><strong>Last Fronted:</strong> ${timeSince(ts)}</span>`);
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * getCurrentFronters(elementId)
   *
   * Drop-in replacement for the Octocon version.
   * Renders "Currently Fronting: …" into the element and keeps it live.
   */
  window.getCurrentFronters = function (elementId) {
    if (!frontersTargets.some(t => t.elementId === elementId)) {
      frontersTargets.push({ elementId });
    }
    renderFronters(elementId);
  };

  /**
   * getLastFrontedDateTime(elementId, memberId)
   *
   * Drop-in replacement for the Octocon version.
   * Renders "Last Fronted: X ago" (or "Actively Fronting Now!") and keeps it live.
   *
   * memberId must be the PluralKit member UUID (long form).
   * Find it with: pk;member <name>  or via the PluralKit dashboard.
   */
  window.getLastFrontedDateTime = function (elementId, memberId) {
    const key = String(memberId);

    if (!lastFrontedTargets.some(t => t.memberId === key && t.elementId === elementId)) {
      lastFrontedTargets.push({ memberId: key, elementId });
    }

    if (historyLoaded) {
      renderLastFronted(key, elementId);
    } else if (ready) {
      socket.send(JSON.stringify({ event: 'get_last_fronted_all' }));
    }
    // If socket isn't open yet, onopen will request history automatically.
  };

  // ─── tick loop for relative timestamps ────────────────────────────────────

  setInterval(() => {
    if (!historyLoaded) return;
    refreshLastFrontedElements();
  }, 1000);

  // ─── boot ─────────────────────────────────────────────────────────────────

  connect();

})();
