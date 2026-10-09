const monthInput = document.querySelector("#report-month");
const reportError = document.querySelector("#report-error");
const domainGrid = document.querySelector("#report-domain-grid");
const technologyReports = document.querySelector("#monthly-technology-reports");

function formatDuration(totalSeconds) {
    const seconds = Math.round(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
}

function formatHours(totalSeconds) {
    return (totalSeconds / 3600).toLocaleString(undefined, {
        maximumFractionDigits: 1,
    });
}

function setDayCount(elementId, count) {
    document.querySelector(elementId).textContent = `${count} logged ${count === 1 ? "day" : "days"}`;
}

function createTechnologyReport(domain) {
    const section = document.createElement("section");
    section.className = "monthly-domain-report";
    const heading = document.createElement("h3");
    heading.textContent = domain.domain_name;

    const callouts = document.createElement("div");
    callouts.className = "technology-callouts";
    const most = document.createElement("p");
    const least = document.createElement("p");
    const mostName = domain.most_studied
        ? `${domain.most_studied.technology_name} · ${formatHours(domain.most_studied.study_seconds)} h`
        : "None yet";
    const leastName = domain.least_studied
        ? `${domain.least_studied.technology_name} · ${formatHours(domain.least_studied.study_seconds)} h`
        : "None yet";
    most.append("Most studied: ");
    const mostValue = document.createElement("strong");
    mostValue.textContent = mostName;
    most.append(mostValue);
    least.append("Least studied: ");
    const leastValue = document.createElement("strong");
    leastValue.textContent = leastName;
    least.append(leastValue);
    callouts.append(most, least);

    const scroll = document.createElement("div");
    scroll.className = "table-scroll monthly-technology-scroll";
    const table = document.createElement("table");
    table.className = "history-table monthly-technology-table";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Technology", "Hours studied", "% of domain", "Target hours", "Status"]) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = label;
        header.append(cell);
    }
    thead.append(header);

    const tbody = document.createElement("tbody");
    const groups = domain.domain_name === "SDE"
        ? ["Frontend", "Backend", "General"].map((category) => ({
            category,
            technologies: domain.technologies.filter((technology) => (technology.category || "General") === category),
        }))
        : [{ category: null, technologies: domain.technologies }];
    for (const group of groups) {
        if (group.category && group.technologies.length === 0) {
            continue;
        }
        if (group.category) {
            const groupRow = document.createElement("tr");
            groupRow.className = "technology-category-report-heading";
            const groupCell = document.createElement("th");
            groupCell.scope = "rowgroup";
            groupCell.colSpan = 5;
            groupCell.textContent = group.category;
            groupRow.append(groupCell);
            tbody.append(groupRow);
        }
        for (const technology of group.technologies) {
            const row = document.createElement("tr");
            const values = [
                technology.technology_name,
                `${formatHours(technology.study_seconds)} h`,
                `${technology.domain_percent.toFixed(1)}%`,
                technology.target_hours === null ? "—" : `${formatHours(technology.target_hours * 3600)} h`,
                technology.status,
            ];
            for (const [index, value] of values.entries()) {
                const cell = document.createElement("td");
                cell.textContent = value;
                if (index === 4) {
                    cell.className = `technology-status status-${technology.status.toLowerCase().replaceAll(" ", "-")}`;
                }
                row.append(cell);
            }
            tbody.append(row);
        }
    }

    table.append(thead, tbody);
    scroll.append(table);
    section.append(heading, callouts, scroll);
    return section;
}

async function loadReport() {
    reportError.hidden = true;
    try {
        const response = await fetch(`/api/report/monthly?month=${encodeURIComponent(monthInput.value)}`);
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to load this report.");
        }

        domainGrid.replaceChildren();
        for (const [domain, seconds] of Object.entries(result.domain_totals)) {
            const card = document.createElement("article");
            card.className = "report-domain-card";
            const title = document.createElement("p");
            title.textContent = domain;
            const total = document.createElement("strong");
            total.textContent = formatDuration(seconds);
            const hours = document.createElement("span");
            hours.textContent = `${formatHours(seconds)} study hours`;
            card.append(title, total, hours);
            domainGrid.append(card);
        }

        document.querySelector("#college-average").textContent = formatDuration(
            result.college_day_average_seconds,
        );
        document.querySelector("#non-college-average").textContent = formatDuration(
            result.non_college_day_average_seconds,
        );
        setDayCount("#college-day-count", result.college_day_count);
        setDayCount("#non-college-day-count", result.non_college_day_count);
        technologyReports.replaceChildren(...result.technology_details.map(createTechnologyReport));
    } catch (error) {
        reportError.textContent = error.message;
        reportError.hidden = false;
    }
}

monthInput.addEventListener("change", loadReport);
loadReport();