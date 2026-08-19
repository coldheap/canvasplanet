(function () {
  "use strict";

  var COMPONENTS = [
    { key: "canvas", name: "Canvas & painting" },
    { key: "realtime", name: "Realtime updates" },
    { key: "database", name: "Database" },
  ];
  var STATE_LABEL = {
    operational: "Operational",
    degraded: "Degraded performance",
    down: "Unavailable",
    nodata: "No data",
  };
  var DAYS = 90;
  var POLL_MS = 15_000;
  var TIMEOUT_MS = 8_000;
  var snapshot = null;
  var history = null;
  var connected = false;
  var pollTimer = null;
  var componentRefs = {};

  var banner = document.getElementById("status-banner");
  var statusTitle = document.getElementById("status-title");
  var statusAge = document.getElementById("status-age");
  var statusDetail = document.getElementById("status-detail");
  var coverage = document.getElementById("coverage");
  var historyError = document.getElementById("history-error");
  var componentList = document.getElementById("component-list");
  var incidentList = document.getElementById("incident-list");
  var lastChecked = document.getElementById("last-checked");
  var tooltip = document.getElementById("tooltip");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function currentState(component) {
    if (!snapshot || !snapshot.components) return "nodata";
    var state = snapshot.components[component.key] || "nodata";
    if (component.key === "canvas" && snapshot.frozen && state === "operational") return "degraded";
    return state;
  }

  function formatPercent(ratio) {
    if (!Number.isFinite(ratio)) return "No data";
    var value = Math.max(0, Math.min(100, ratio * 100));
    if (value === 100) return "100%";
    return value.toFixed(value >= 99 ? 2 : value >= 90 ? 1 : 0).replace(/\.0+$/, "") + "%";
  }

  function formatDate(date, year) {
    var options = { month: "short", day: "numeric", timeZone: "UTC" };
    if (year) options.year = "numeric";
    return new Intl.DateTimeFormat(undefined, options).format(new Date(date + "T00:00:00Z"));
  }

  function relativeTime(time) {
    var elapsed = Math.max(0, Date.now() - time);
    if (elapsed < 10_000) return "Updated just now";
    if (elapsed < 60_000) return "Updated " + Math.floor(elapsed / 1_000) + "s ago";
    return "Updated " + Math.floor(elapsed / 60_000) + "m ago";
  }

  function renderBanner(override) {
    var state = override || (snapshot && snapshot.overall) || "unknown";
    if (!override && snapshot && snapshot.frozen && state === "operational") state = "degraded";
    banner.className = "status-banner " + state;
    statusDetail.hidden = true;

    if (state === "operational") statusTitle.textContent = "All systems operational";
    else if (state === "degraded") statusTitle.textContent = "Some systems are experiencing issues";
    else if (state === "down") statusTitle.textContent = "Service interruption";
    else statusTitle.textContent = "Status unavailable";

    if (snapshot && snapshot.frozen && state === "degraded") {
      statusDetail.textContent = "Painting is temporarily paused.";
      statusDetail.hidden = false;
    } else if (state === "unknown") {
      statusDetail.textContent = "The application health check did not respond.";
      statusDetail.hidden = false;
    }

    document.title = statusTitle.textContent + " · CanvasPlanet Status";
  }

  function updateAge() {
    if (!snapshot || !snapshot.time) return;
    var checkedAt = Date.parse(snapshot.time);
    statusAge.textContent = connected ? relativeTime(checkedAt) : "Last known status";
    lastChecked.textContent = "Last checked " + new Date(checkedAt).toLocaleString();
  }

  function weightedUptime(componentKey) {
    if (!history) return null;
    var up = 0;
    var samples = 0;
    history.history.forEach(function (day) {
      var ratio = day.componentUptimeRatio && day.componentUptimeRatio[componentKey];
      if (day.samples > 0 && Number.isFinite(ratio)) {
        up += ratio * day.samples;
        samples += day.samples;
      }
    });
    return samples ? up / samples : null;
  }

  function placeholderDays() {
    var days = [];
    for (var i = 0; i < DAYS; i++) {
      days.push({ date: "", samples: 0, components: { canvas: "nodata", realtime: "nodata", database: "nodata" } });
    }
    return days;
  }

  function renderComponents() {
    clear(componentList);
    componentRefs = {};
    var days = history ? history.history : placeholderDays();

    COMPONENTS.forEach(function (component) {
      var row = el("article", "component");
      var head = el("div", "component-head");
      head.appendChild(el("h3", "", component.name));
      var state = el("span", "component-state nodata", "Checking");
      head.appendChild(state);

      var strip = el("div", "history-strip");
      strip.tabIndex = 0;
      strip.dataset.cursor = String(days.length - 1);
      strip.setAttribute("role", "img");
      strip.setAttribute("aria-label", component.name + ", 90-day uptime history. Use the arrow keys to inspect days.");
      days.forEach(function (day, index) {
        var dayState = day.components && day.components[component.key] || "nodata";
        var bar = el("span", "history-day " + dayState);
        bar.dataset.index = String(index);
        bar.setAttribute("aria-hidden", "true");
        strip.appendChild(bar);
      });

      var meta = el("div", "history-meta");
      meta.appendChild(el("span", "", days[0] && days[0].date ? formatDate(days[0].date, false) : "90 days ago"));
      meta.appendChild(el("span", "", formatPercent(weightedUptime(component.key)) + " uptime"));
      meta.appendChild(el("span", "", "Today"));

      row.appendChild(head);
      row.appendChild(strip);
      row.appendChild(meta);
      componentList.appendChild(row);
      componentRefs[component.key] = state;
    });

    updateComponentStates();
  }

  function updateComponentStates() {
    COMPONENTS.forEach(function (component) {
      var node = componentRefs[component.key];
      if (!node) return;
      var state = currentState(component);
      node.className = "component-state " + state;
      node.textContent = (connected ? "" : "Last known · ") + STATE_LABEL[state];
    });
  }

  function renderCoverage() {
    if (!history) {
      coverage.textContent = "";
      return;
    }
    var monitored = history.history.filter(function (day) { return day.samples > 0; }).length;
    coverage.textContent = monitored === DAYS ? "" : monitored + " of " + DAYS + " days recorded";
  }

  function severity(state) {
    return { nodata: -1, operational: 0, degraded: 1, down: 2 }[state] || 0;
  }

  function incidentGroups() {
    var groups = [];
    var current = null;
    history.history.forEach(function (day) {
      if (day.overall === "operational" || day.overall === "nodata") {
        current = null;
        return;
      }
      if (!current) {
        current = { start: day.date, end: day.date, state: day.overall, affected: {} };
        groups.push(current);
      }
      current.end = day.date;
      if (severity(day.overall) > severity(current.state)) current.state = day.overall;
      COMPONENTS.forEach(function (component) {
        var state = day.components && day.components[component.key];
        if (state && state !== "operational" && state !== "nodata") current.affected[component.key] = true;
      });
    });
    return groups.reverse().slice(0, 8);
  }

  function renderIncidents() {
    clear(incidentList);
    if (!history) {
      incidentList.appendChild(el("p", "muted", "Incident history is unavailable."));
      return;
    }
    var groups = incidentGroups();
    if (!groups.length) {
      incidentList.appendChild(el("p", "muted", "No incidents reported in recorded checks."));
      return;
    }
    var list = el("div", "incident-list");
    groups.forEach(function (group) {
      var item = el("article", "incident");
      var date = group.start === group.end ? formatDate(group.start, true) : formatDate(group.start, false) + " – " + formatDate(group.end, true);
      item.appendChild(el("time", "", date));
      var copy = el("p");
      copy.appendChild(el("strong", "", group.state === "down" ? "Service interruption" : "Degraded performance"));
      var affected = COMPONENTS.filter(function (component) { return group.affected[component.key]; }).map(function (component) { return component.name; });
      copy.appendChild(el("span", "", affected.join(", ")));
      item.appendChild(copy);
      list.appendChild(item);
    });
    incidentList.appendChild(list);
  }

  function selectDay(index) {
    var bars = componentList.querySelectorAll(".history-day");
    for (var i = 0; i < bars.length; i++) {
      bars[i].classList.toggle("selected", Number(bars[i].dataset.index) === index);
    }
  }

  function showTooltip(index) {
    if (!history || !history.history[index]) return;
    var day = history.history[index];
    clear(tooltip);
    var head = el("div", "tooltip-head");
    head.appendChild(el("span", "", formatDate(day.date, true)));
    head.appendChild(el("span", "", day.samples ? day.samples + " checks" : "No data"));
    tooltip.appendChild(head);
    COMPONENTS.forEach(function (component) {
      var row = el("div", "tooltip-row");
      var state = day.components && day.components[component.key] || "nodata";
      row.appendChild(el("span", "", component.name));
      row.appendChild(el("span", "", STATE_LABEL[state]));
      tooltip.appendChild(row);
    });
    tooltip.hidden = false;
    selectDay(index);
  }

  function hideTooltip() {
    tooltip.hidden = true;
    selectDay(-1);
  }

  function fetchJson(url, allow503) {
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } })
      .then(function (response) {
        var type = response.headers.get("content-type") || "";
        if ((!response.ok && !(allow503 && response.status === 503)) || type.indexOf("json") === -1) throw new Error("Unexpected response");
        return response.json();
      })
      .finally(function () { window.clearTimeout(timeout); });
  }

  function loadStatus() {
    window.clearTimeout(pollTimer);
    fetchJson("/api/status", true)
      .then(function (data) {
        if (!data || !data.components || !data.time) throw new Error("Invalid status");
        snapshot = data;
        connected = true;
        renderBanner();
        updateAge();
        updateComponentStates();
      })
      .catch(function () {
        connected = false;
        renderBanner("unknown");
        updateAge();
        updateComponentStates();
      })
      .finally(function () { pollTimer = window.setTimeout(loadStatus, POLL_MS); });
  }

  function loadHistory() {
    historyError.hidden = true;
    fetchJson("/api/status/history?days=" + DAYS, false)
      .then(function (data) {
        if (!data || data.days !== DAYS || !Array.isArray(data.history) || data.history.length !== DAYS) throw new Error("Invalid history");
        history = data;
        renderComponents();
        renderCoverage();
        renderIncidents();
      })
      .catch(function () {
        history = null;
        historyError.hidden = false;
        renderComponents();
        renderCoverage();
        renderIncidents();
      });
  }

  componentList.addEventListener("pointerover", function (event) {
    var bar = event.target.closest(".history-day");
    if (bar) showTooltip(Number(bar.dataset.index));
  });
  componentList.addEventListener("pointerout", function (event) {
    if (!event.relatedTarget || !componentList.contains(event.relatedTarget)) hideTooltip();
  });
  componentList.addEventListener("focusin", function (event) {
    var strip = event.target.closest(".history-strip");
    if (strip) showTooltip(Number(strip.dataset.cursor));
  });
  componentList.addEventListener("focusout", function (event) {
    if (!event.relatedTarget || !componentList.contains(event.relatedTarget)) hideTooltip();
  });
  componentList.addEventListener("keydown", function (event) {
    var strip = event.target.closest(".history-strip");
    if (!strip || !history) return;
    var cursor = Number(strip.dataset.cursor);
    if (event.key === "ArrowLeft") cursor--;
    else if (event.key === "ArrowRight") cursor++;
    else if (event.key === "Home") cursor = 0;
    else if (event.key === "End") cursor = DAYS - 1;
    else if (event.key === "Escape") { hideTooltip(); return; }
    else return;
    event.preventDefault();
    cursor = Math.max(0, Math.min(DAYS - 1, cursor));
    strip.dataset.cursor = String(cursor);
    showTooltip(cursor);
  });

  document.getElementById("history-retry").addEventListener("click", loadHistory);
  renderBanner("unknown");
  renderComponents();
  loadStatus();
  loadHistory();
  window.setInterval(updateAge, 1_000);
})();
