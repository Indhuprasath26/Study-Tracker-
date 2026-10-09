const historyForm = document.querySelector("#history-filters");
const historyRows = document.querySelector("#history-rows");
const historyMessage = document.querySelector("#history-message");
const historyCount = document.querySelector("#history-count");
const eventDialog = document.querySelector("#event-dialog");
const eventRows = document.querySelector("#event-rows");
const eventMessage = document.querySelector("#event-message");
const domainFilter = document.querySelector("#filter-domain");
const technologyFilter = document.querySelector("#filter-technology");
let technologyFilterRequest = 0;

function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
}

function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(new Date(`${value}T00:00:00`));
}

function formatTime(value) {
    if (!value) {
        return "In progress";
    }
    return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(value));
}

function formatDateTime(value) {
    if (!value) {
        return "";
    }
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    }).format(new Date(value));
}

async function getJson(url) {
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Unable to load study data.");
    }
    return result;
}

function createCell(value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    return cell;
}

async function loadHistory() {
    historyMessage.hidden = true;
    const query = new URLSearchParams();
    const formData = new FormData(historyForm);
    for (const field of ["start_date", "end_date", "domain_id", "technology_id"]) {
        const value = formData.get(field);
        if (value) {
            query.set(field, value);
        }
    }
    if (formData.has("college_day")) {
        query.set("college_day", "1");
    }

    try {
        const result = await getJson(`/api/sessions?${query.toString()}`);
        historyRows.replaceChildren();
        historyCount.textContent = `${result.sessions.length} sessions`;

        if (result.sessions.length === 0) {
            const row = document.createElement("tr");
            const cell = createCell("No sessions match these filters.");
            cell.colSpan = 8;
            row.append(cell);
            historyRows.append(row);
            return;
        }

        for (const session of result.sessions) {
            const row = document.createElement("tr");
            const dateCell = document.createElement("td");
            const detailsButton = document.createElement("button");
            detailsButton.className = "history-date-button";
            detailsButton.type = "button";
            detailsButton.dataset.sessionId = session.session_id;
            detailsButton.textContent = formatDate(session.date);
            detailsButton.setAttribute(
                "aria-label",
                `View events for ${formatDate(session.date)} ${session.domain_name}`,
            );
            dateCell.append(detailsButton);
            row.append(
                dateCell,
                createCell(session.domain_name),
                createCell(session.technology_name || "General"),
                createCell(session.is_college_day ? "Y" : "N"),
                createCell(formatTime(session.started_at)),
                createCell(session.ended_at ? formatTime(session.ended_at) : session.status),
                createCell(formatDuration(session.study_seconds)),
                createCell(formatDuration(session.pause_seconds)),
            );
            historyRows.append(row);
        }
    } catch (error) {
        historyRows.replaceChildren();
        historyCount.textContent = "";
        historyMessage.textContent = error.message;
        historyMessage.hidden = false;
    }
}

async function loadTechnologyFilter(domainId) {
    const requestId = ++technologyFilterRequest;
    technologyFilter.replaceChildren(new Option(
        domainId ? "Loading technologies..." : "Choose a domain first",
        "",
    ));
    technologyFilter.disabled = true;
    if (!domainId) {
        return;
    }

    try {
        const result = await getJson(`/api/technologies?domain_id=${encodeURIComponent(domainId)}`);
        if (requestId !== technologyFilterRequest || domainFilter.value !== String(domainId)) {
            return;
        }
        technologyFilter.replaceChildren(new Option("All technologies", ""));
        const selectedDomain = domainFilter.selectedOptions[0]?.textContent;
        if (selectedDomain === "SDE") {
            for (const category of ["Frontend", "Backend", "General"]) {
                const group = document.createElement("optgroup");
                group.label = category;
                for (const technology of result.technologies.filter(
                    (item) => (item.category || "General") === category,
                )) {
                    group.append(new Option(technology.name, String(technology.id)));
                }
                if (group.options.length) {
                    technologyFilter.add(group);
                }
            }
        } else {
            for (const technology of result.technologies) {
                technologyFilter.add(new Option(technology.name, String(technology.id)));
            }
        }
        technologyFilter.disabled = result.technologies.length === 0;
    } catch (error) {
        if (requestId === technologyFilterRequest) {
            technologyFilter.replaceChildren(new Option("Unable to load technologies", ""));
            historyMessage.textContent = error.message;
            historyMessage.hidden = false;
        }
    }
}

async function showEventLog(sessionId, trigger) {
    eventRows.replaceChildren();
    eventMessage.hidden = true;
    eventDialog.showModal();

    try {
        const result = await getJson(`/api/sessions/${sessionId}/events`);
        for (const event of result.events) {
            const row = document.createElement("tr");
            row.append(createCell(event.event_type), createCell(formatDateTime(event.event_time)));
            eventRows.append(row);
        }
        if (result.events.length === 0) {
            eventMessage.textContent = "No events were recorded for this session.";
            eventMessage.hidden = false;
        }
    } catch (error) {
        eventMessage.textContent = error.message;
        eventMessage.hidden = false;
    }

    trigger.focus();
}

historyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loadHistory();
});

historyForm.addEventListener("reset", () => {
    window.setTimeout(loadHistory, 0);
    window.setTimeout(() => loadTechnologyFilter(domainFilter.value), 0);
});

domainFilter.addEventListener("change", () => {
    loadTechnologyFilter(domainFilter.value);
    technologyFilter.value = "";
});

historyRows.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-session-id]");
    if (trigger) {
        showEventLog(Number(trigger.dataset.sessionId), trigger);
    }
});

document.querySelector("#close-event-dialog").addEventListener("click", () => eventDialog.close());
eventDialog.addEventListener("close", () => document.querySelector("#history-heading").focus());

loadHistory();
loadTechnologyFilter(domainFilter.value);