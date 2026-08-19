(function () {
  "use strict";

  var COMPONENTS = [
    { key: "canvas", name: "Canvas & painting", description: "Paint submissions, validation, and tile delivery" },
    { key: "realtime", name: "Realtime updates", description: "Live delivery of new pixels and activity" },
    { key: "database", name: "Data store", description: "Primary data queries used by the canvas" },
  ];

  var STATE_LABEL = {
    operational: "Operational",
    degraded: "Degraded",
    down: "Unavailable",
    nodata: "No data",
  };

  var OVERALL_CONTENT = {
    operational: {
      kicker: "Current status · Operational",
      title: "All systems operational",
      message: "CanvasPlanet services are responding normally.",
    },
    degraded: {
      kicker: "Current status · Degraded",
      title: "Some systems are degraded",
      message: "CanvasPlanet is available, but one or more services are responding slowly.",
    },
    down: {
      kicker: "Current status · Outage",
      title: "Service interruption",
      message: "One or more CanvasPlanet services are currently unavailable.",
    },
    unreachable: {
      kicker: "Live status unavailable",
      title: "We cannot reach the status API",
      message: "The status page is online, but the application health check did not respond.",
    },
  };

  var POLL_MS = 15_000;
  var REQUEST_TIMEOUT_MS = 8_000;
  var STALE_AFTER_MS = 45_000;
  var selectedDays = 90;
  var latestSnapshot = null;
  var latestHistory = null;
  var statusConnected = false;
  var historyController = null;
  var pollTimer = null;
  var componentRefs = {};

  var overallCard = document.getElementById("overall-card");
  var overallKicker = document.getElementById("overall-kicker");
  var overallTitle = document.getElementById("overall-title");
  var overallMessage = document.getElementById("overall-message");
  var statusAge = document.getElementById("status-age");
  var statusRetry = document.getElementById("status-retry");
  var summaryRange = document.getElementById("summary-range");
  var overallUptime = document.getElementById("overall-uptime");
  var monitoredDays = document.getElementById("monitored-days");
  var monitoredDaysDetail = document.getElementById("monitored-days-detail");
  var recordedChecks = document.getElementById("recorded-checks");
  var rangeControl = document.getElementById("range-control");
  var historyNotice = document.getElementById("history-notice");
  var historyNoticeText = document.getElementById("history-notice-text");
  var historyRetry = document.getElementById("history-retry");
  var componentList = document.getElementById("component-list");
  var eventsList = document.getElementById("events-list");
  var telemetryTime = document.getElementById("telemetry-time");
  var footerChecked = document.getElementById("footer-checked");
  var tooltip = document.getElementById("history-tooltip");
  var favicon = document.getElementById("favicon");

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—";
  }

  function formatPercent(ratio) {
    if (!Number.isFinite(ratio)) return "No data";
    var percent = Math.max(0, Math.min(100, ratio * 100));
    if (percent === 100) return "100%";
    var decimals = percent >= 99 ? 2 : percent >= 90 ? 1 : 0;
    return percent.toFixed(decimals).replace(/\.0+$/, "") + "%";
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    var days = Math.floor(seconds / 86_400);
    var hours = Math.floor((seconds % 86_400) / 3_600);
    var minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + minutes + "m";
    return minutes + "m";
  }

  function formatDate(date, includeYear) {
    var options = { month: "short", day: "numeric", timeZone: "UTC" };
    if (includeYear) options.year = "numeric";
    return new Intl.DateTimeFormat(undefined, options).format(new Date(date + "T00:00:00Z"));
  }

  function relativeTime(timestamp) {
    var elapsed = Math.max(0, Date.now() - timestamp);
    if (elapsed < 10_000) return "Updated just now";
    if (elapsed < 60_000) return "Updated " + Math.floor(elapsed / 1_000) + " seconds ago";
    var minutes = Math.floor(elapsed / 60_000);
    return "Updated " + minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  }

  function setFavicon(state) {
    var colors = { operational: "#17834f", degraded: "#a85b08", down: "#be3b3b", unreachable: "#be3b3b" };
    var color = colors[state] || "#3556e8";
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='" + color + "'/><circle cx='16' cy='16' r='6' fill='white'/></svg>";
    favicon.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function currentState(component) {
    if (!latestSnapshot || !latestSnapshot.components) return "nodata";
    var state = latestSnapshot.components[component.key] || "nodata";
    if (component.key === "canvas" && latestSnapshot.frozen && state === "operational") return "degraded";
    return state;
  }

  function renderOverall(stateOverride) {
    var state = stateOverride;
    if (!state && latestSnapshot) {
      state = latestSnapshot.overall || "unreachable";
      if (latestSnapshot.frozen && state === "operational") state = "degraded";
    }
    if (!state) state = "unreachable";

    var content = OVERALL_CONTENT[state] || OVERALL_CONTENT.unreachable;
    overallCard.className = "overall-card " + state;
    overallKicker.textContent = content.kicker;
    overallTitle.textContent = content.title;
    overallMessage.textContent = latestSnapshot && latestSnapshot.frozen
      ? "Painting is temporarily paused. Reading the canvas remains available."
      : content.message;
    statusRetry.hidden = state !== "unreachable";
    setFavicon(state);
    document.title = (state === "operational" ? "Operational" : content.title) + " · CanvasPlanet Status";
  }

  function updateStatusAge() {
    if (!latestSnapshot || !latestSnapshot.time) {
      statusAge.textContent = statusConnected ? "Latest check received" : "Waiting for response";
      return;
    }

    var timestamp = Date.parse(latestSnapshot.time);
    statusAge.textContent = relativeTime(timestamp);
    footerChecked.textContent = "Last successful check " + new Date(timestamp).toLocaleString();
    if (statusConnected && Date.now() - timestamp > STALE_AFTER_MS) {
      statusConnected = false;
      renderOverall("unreachable");
      updateLiveComponents();
    }
  }

  function updateTelemetry() {
    if (!latestSnapshot) return;
    document.getElementById("metric-paints").textContent = formatNumber(latestSnapshot.paintsPerSec);
    document.getElementById("metric-clients").textContent = formatNumber(latestSnapshot.connectedClients);
    document.getElementById("metric-db").textContent = Number.isFinite(latestSnapshot.dbLatencyMs)
      ? latestSnapshot.dbLatencyMs.toLocaleString(undefined, { maximumFractionDigits: 1 })
      : "—";
    document.getElementById("metric-queue").textContent = latestSnapshot.tileQueueDepth >= 0
      ? formatNumber(latestSnapshot.tileQueueDepth)
      : "Unknown";
    document.getElementById("metric-process").textContent = formatDuration(latestSnapshot.uptimeSeconds);
    telemetryTime.textContent = statusConnected ? "Live · " + new Date(latestSnapshot.time).toLocaleTimeString() : "Last known values";

    var dbCard = document.getElementById("metric-db-card");
    dbCard.className = "telemetry-card" + (!latestSnapshot.dbOk ? " is-down" : latestSnapshot.dbLatencyMs > 200 ? " is-warning" : "");
    var queueCard = document.getElementById("metric-queue-card");
    queueCard.className = "telemetry-card" + (latestSnapshot.tileQueueDepth < 0 ? " is-down" : latestSnapshot.tileQueueDepth > 5_000 ? " is-warning" : "");
  }

  function updateLiveComponents() {
    COMPONENTS.forEach(function (component) {
      var refs = componentRefs[component.key];
      if (!refs) return;
      var state = currentState(component);
      refs.dot.className = "state-dot " + state;
      refs.state.textContent = (statusConnected ? "" : "Last known · ") + (STATE_LABEL[state] || "No data");
    });
  }

  function weightedRatio(history, componentKey) {
    if (!history || !history.history) return null;
    var successful = 0;
    var samples = 0;
    history.history.forEach(function (day) {
      var ratio = componentKey
        ? day.componentUptimeRatio && day.componentUptimeRatio[componentKey]
        : day.uptimeRatio;
      if (day.samples > 0 && Number.isFinite(ratio)) {
        successful += ratio * day.samples;
        samples += day.samples;
      }
    });
    return samples > 0 ? successful / samples : null;
  }

  function renderSummary(history) {
    summaryRange.textContent = selectedDays;
    if (!history) {
      overallUptime.textContent = "—";
      monitoredDays.textContent = "—";
      recordedChecks.textContent = "—";
      monitoredDaysDetail.textContent = "Within this window";
      return;
    }

    var daysWithData = 0;
    var samples = 0;
    history.history.forEach(function (day) {
      if (day.samples > 0) daysWithData++;
      samples += day.samples || 0;
    });
    overallUptime.textContent = formatPercent(weightedRatio(history));
    monitoredDays.textContent = daysWithData + " / " + history.days;
    monitoredDaysDetail.textContent = history.days - daysWithData === 0 ? "Complete daily coverage" : (history.days - daysWithData) + " days have no data";
    recordedChecks.textContent = formatNumber(samples);
  }

  function historyDaysOrPlaceholder(history) {
    if (history && Array.isArray(history.history)) return history.history;
    var days = [];
    for (var i = 0; i < selectedDays; i++) {
      days.push({ date: "", overall: "nodata", samples: 0, components: { canvas: "nodata", realtime: "nodata", database: "nodata" } });
    }
    return days;
  }

  function renderComponents(history) {
    clear(componentList);
    componentRefs = {};
    var days = historyDaysOrPlaceholder(history);

    COMPONENTS.forEach(function (component) {
      var card = make("article", "component-card");
      var top = make("div", "component-top");
      var identity = make("div");
      var titleRow = make("div", "component-title-row");
      var dot = make("span", "state-dot nodata");
      dot.setAttribute("aria-hidden", "true");
      titleRow.appendChild(dot);
      titleRow.appendChild(make("h3", "", component.name));
      identity.appendChild(titleRow);
      identity.appendChild(make("p", "component-description", component.description));

      var stat = make("div", "component-stat");
      var state = make("span", "component-state", "Checking");
      var ratio = weightedRatio(history, component.key);
      var uptime = make("span", "component-uptime", Number.isFinite(ratio) ? formatPercent(ratio) + " recorded uptime" : "Recorded uptime unavailable");
      stat.appendChild(state);
      stat.appendChild(uptime);
      top.appendChild(identity);
      top.appendChild(stat);

      var strip = make("div", "history-strip");
      strip.tabIndex = 0;
      strip.dataset.component = component.key;
      strip.dataset.cursor = String(Math.max(0, days.length - 1));
      strip.setAttribute("role", "img");
      strip.setAttribute("aria-label", component.name + ", " + selectedDays + "-day recorded status history. Use left and right arrow keys to inspect days.");
      days.forEach(function (day, index) {
        var dayState = day.components && day.components[component.key] || "nodata";
        var bar = make("span", "history-day " + dayState);
        bar.dataset.index = String(index);
        bar.setAttribute("aria-hidden", "true");
        strip.appendChild(bar);
      });

      var caption = make("div", "history-caption");
      caption.appendChild(make("span", "", days[0] && days[0].date ? formatDate(days[0].date, false) : selectedDays + " days ago"));
      caption.appendChild(make("span", "", "Today"));
      card.appendChild(top);
      card.appendChild(strip);
      card.appendChild(caption);
      componentList.appendChild(card);
      componentRefs[component.key] = { dot: dot, state: state, uptime: uptime };
    });

    updateLiveComponents();
  }

  function worstState(a, b) {
    var severity = { operational: 0, degraded: 1, down: 2, nodata: -1 };
    return severity[b] > severity[a] ? b : a;
  }

  function disruptionGroups(history) {
    var groups = [];
    var current = null;
    history.history.forEach(function (day) {
      if (day.overall === "operational" || day.overall === "nodata") {
        current = null;
        return;
      }
      if (!current) {
        current = { start: day.date, end: day.date, state: day.overall, days: [], affected: {} };
        groups.push(current);
      }
      current.end = day.date;
      current.state = worstState(current.state, day.overall);
      current.days.push(day);
      COMPONENTS.forEach(function (component) {
        var state = day.components && day.components[component.key];
        if (state && state !== "operational" && state !== "nodata") current.affected[component.key] = true;
      });
    });
    return groups.reverse().slice(0, 5);
  }

  function renderEvents(history) {
    clear(eventsList);
    if (!history) {
      var unavailable = make("div", "empty-state has-gaps");
      unavailable.appendChild(make("span", "empty-icon"));
      var unavailableCopy = make("div");
      unavailableCopy.appendChild(make("strong", "", "Disruption history unavailable"));
      unavailableCopy.appendChild(make("p", "", "Retry the recorded uptime request above."));
      unavailable.appendChild(unavailableCopy);
      eventsList.appendChild(unavailable);
      return;
    }

    var groups = disruptionGroups(history);
    if (groups.length === 0) {
      var missingDays = history.history.filter(function (day) { return day.samples === 0; }).length;
      var empty = make("div", "empty-state" + (missingDays ? " has-gaps" : ""));
      var emptyIcon = make("span", "empty-icon");
      emptyIcon.setAttribute("aria-hidden", "true");
      var emptyCopy = make("div");
      emptyCopy.appendChild(make("strong", "", history.history.every(function (day) { return day.samples === 0; }) ? "No monitoring data yet" : "No disruptions in recorded checks"));
      emptyCopy.appendChild(make("p", "", missingDays
        ? "No degraded checks were recorded; " + missingDays + " day" + (missingDays === 1 ? " has" : "s have") + " no data."
        : "All recorded checks in this window were operational."));
      empty.appendChild(emptyIcon);
      empty.appendChild(emptyCopy);
      eventsList.appendChild(empty);
      return;
    }

    groups.forEach(function (group) {
      var item = make("article", "event-item " + group.state);
      item.appendChild(make("span", "event-marker"));
      var body = make("div");
      var header = make("div", "event-header");
      header.appendChild(make("span", "event-title", group.state === "down" ? "Service interruption detected" : "Degraded performance detected"));
      var date = group.start === group.end ? formatDate(group.start, true) : formatDate(group.start, false) + " – " + formatDate(group.end, true);
      header.appendChild(make("time", "event-date", date));
      var affected = COMPONENTS.filter(function (component) { return group.affected[component.key]; }).map(function (component) { return component.name; });
      var groupSamples = group.days.reduce(function (sum, day) { return sum + day.samples; }, 0);
      var detail = (affected.length ? affected.join(", ") : "Service health") + " · " + groupSamples + " recorded check" + (groupSamples === 1 ? "" : "s");
      body.appendChild(header);
      body.appendChild(make("p", "event-detail", detail));
      item.appendChild(body);
      eventsList.appendChild(item);
    });
  }

  function setHistoryNotice(kind, message) {
    if (kind === "hidden") {
      historyNotice.hidden = true;
      return;
    }
    historyNotice.hidden = false;
    historyNotice.className = "inline-notice" + (kind === "error" ? " is-error" : "");
    historyNoticeText.textContent = message;
    historyRetry.hidden = kind !== "error";
  }

  function showTooltip(index) {
    if (!latestHistory || !latestHistory.history[index]) return;
    var day = latestHistory.history[index];
    clear(tooltip);
    var top = make("div", "tooltip-date");
    top.appendChild(make("span", "", formatDate(day.date, true)));
    top.appendChild(make("span", "tooltip-value", Number.isFinite(day.uptimeRatio) ? formatPercent(day.uptimeRatio) + " recorded" : "No data"));
    tooltip.appendChild(top);
    COMPONENTS.forEach(function (component) {
      var state = day.components && day.components[component.key] || "nodata";
      var row = make("div", "tooltip-row");
      var label = make("span", "tooltip-label");
      label.appendChild(make("i", "tooltip-dot " + state));
      label.appendChild(make("span", "", component.name));
      row.appendChild(label);
      row.appendChild(make("span", "tooltip-value", STATE_LABEL[state] || "No data"));
      tooltip.appendChild(row);
    });
    if (day.samples > 0) {
      var sampleRow = make("div", "tooltip-row");
      sampleRow.appendChild(make("span", "tooltip-label", "Checks recorded"));
      sampleRow.appendChild(make("span", "tooltip-value", formatNumber(day.samples)));
      tooltip.appendChild(sampleRow);
    }
    tooltip.hidden = false;
    selectHistoryIndex(index);
  }

  function selectHistoryIndex(index) {
    var bars = componentList.querySelectorAll(".history-day");
    for (var i = 0; i < bars.length; i++) {
      bars[i].classList.toggle("is-selected", Number(bars[i].dataset.index) === index);
    }
  }

  function hideTooltip() {
    tooltip.hidden = true;
    selectHistoryIndex(-1);
  }

  function validateStatus(snapshot) {
    return snapshot && typeof snapshot.time === "string" && typeof snapshot.overall === "string" && snapshot.components;
  }

  function validateHistory(history) {
    return history && Number.isFinite(history.days) && Array.isArray(history.history) && history.history.length === history.days;
  }

  function fetchJson(url, allowUnavailable, controller) {
    var timeout = window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } })
      .then(function (response) {
        var type = response.headers.get("content-type") || "";
        if ((!response.ok && !(allowUnavailable && response.status === 503)) || type.indexOf("json") === -1) {
          throw new Error("Unexpected response from " + url);
        }
        return response.json();
      })
      .finally(function () { window.clearTimeout(timeout); });
  }

  function loadStatus() {
    window.clearTimeout(pollTimer);
    var controller = new AbortController();
    return fetchJson("/api/status", true, controller)
      .then(function (snapshot) {
        if (!validateStatus(snapshot)) throw new Error("Invalid status response");
        latestSnapshot = snapshot;
        statusConnected = true;
        renderOverall();
        updateStatusAge();
        updateTelemetry();
        updateLiveComponents();
      })
      .catch(function () {
        statusConnected = false;
        renderOverall("unreachable");
        updateStatusAge();
        updateTelemetry();
        updateLiveComponents();
      })
      .finally(function () {
        pollTimer = window.setTimeout(loadStatus, POLL_MS);
      });
  }

  function loadHistory() {
    if (historyController) historyController.abort();
    historyController = new AbortController();
    var activeController = historyController;
    setHistoryNotice("loading", "Loading " + selectedDays + " days of recorded uptime");

    return fetchJson("/api/status/history?days=" + selectedDays, false, activeController)
      .then(function (history) {
        if (activeController !== historyController) return;
        if (!validateHistory(history) || history.days !== selectedDays) throw new Error("Invalid history response");
        latestHistory = history;
        renderSummary(history);
        renderComponents(history);
        renderEvents(history);
        setHistoryNotice("hidden", "");
      })
      .catch(function (error) {
        if (error && error.name === "AbortError" && activeController !== historyController) return;
        if (activeController !== historyController) return;
        if (!latestHistory || latestHistory.days !== selectedDays) {
          latestHistory = null;
          renderSummary(null);
          renderComponents(null);
          renderEvents(null);
        }
        setHistoryNotice("error", "Recorded uptime could not be loaded.");
      });
  }

  rangeControl.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-days]");
    if (!button) return;
    var nextDays = Number(button.dataset.days);
    if (nextDays === selectedDays) return;
    selectedDays = nextDays;
    Array.prototype.forEach.call(rangeControl.querySelectorAll("button[data-days]"), function (item) {
      item.setAttribute("aria-pressed", String(item === button));
    });
    summaryRange.textContent = selectedDays;
    hideTooltip();
    loadHistory();
  });

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
    if (!strip || !latestHistory) return;
    var cursor = Number(strip.dataset.cursor);
    if (event.key === "ArrowLeft") cursor--;
    else if (event.key === "ArrowRight") cursor++;
    else if (event.key === "Home") cursor = 0;
    else if (event.key === "End") cursor = latestHistory.history.length - 1;
    else if (event.key === "Escape") { hideTooltip(); return; }
    else return;
    event.preventDefault();
    cursor = Math.max(0, Math.min(latestHistory.history.length - 1, cursor));
    strip.dataset.cursor = String(cursor);
    showTooltip(cursor);
  });

  statusRetry.addEventListener("click", loadStatus);
  historyRetry.addEventListener("click", loadHistory);

  function configureHomeLinks() {
    if (/^status\./i.test(window.location.hostname)) {
      var mainHost = window.location.host.replace(/^status\./i, "");
      var target = window.location.protocol + "//" + mainHost + "/";
      document.getElementById("brand-home").href = target;
      document.getElementById("canvas-link").href = target;
    }
  }

  configureHomeLinks();
  renderSummary(null);
  renderComponents(null);
  renderOverall("unreachable");
  overallCard.classList.add("is-loading");
  loadStatus();
  loadHistory();
  window.setInterval(updateStatusAge, 1_000);
})();
