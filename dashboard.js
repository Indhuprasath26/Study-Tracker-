const dashboardMessage = document.querySelector("#dashboard-message");
const technologyChartGrid = document.querySelector("#technology-chart-grid");
const learningDomainSelect = document.querySelector("#learning-path-domain");
const learningCoverage = document.querySelector("#learning-coverage");
const learningPathList = document.querySelector("#learning-path-list");
const learningPathMessage = document.querySelector("#learning-path-message");
const codingProfileForm = document.querySelector("#coding-profile-form");
const codingProfileMessage = document.querySelector("#coding-profile-message");
const codingSyncButton = document.querySelector("#coding-sync-button");
const codingLastSynced = document.querySelector("#coding-last-synced");
const codingSyncSpinner = document.querySelector("#coding-sync-spinner");
const codingToastRegion = document.querySelector("#coding-toast-region");
const leetcodeProfileContent = document.querySelector("#leetcode-profile-content");
let codingProfileSnapshots = {};
let localCodingSyncPlatform = null;

const durationFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

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

function createCodingElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined) {
        element.textContent = text;
    }
    return element;
}

function renderLeetcodeProfile(profile) {
    leetcodeProfileContent.replaceChildren();
    const header = createCodingElement("div", "coding-platform-heading");
    const identity = createCodingElement("div", "coding-platform-identity");
    identity.append(
        createCodingElement("p", "eyebrow", "LEETCODE PROFILE"),
        createCodingElement("h3", "", profile.username ? `@${profile.username}` : "No username saved"),
    );
    const rank = createCodingElement(
        "div",
        "coding-rank-badge",
        profile.snapshot?.global_rank != null
            ? `Global rank ${Number(profile.snapshot.global_rank).toLocaleString()}`
            : "Global rank unavailable",
    );
    header.append(identity, rank);
    leetcodeProfileContent.append(header);

    const snapshot = profile.snapshot;
    if (!snapshot) {
        leetcodeProfileContent.append(
            createCodingElement("p", "coding-empty-state", profile.username
                ? "No LeetCode snapshot yet. Sync to load your stats."
                : "Save your LeetCode username below, then sync your public profile."),
        );
        return;
    }

    const extra = snapshot.extra || {};
    const totals = extra.question_totals || {};
    const total = Number(totals.all) || 0;
    const solved = Number(snapshot.total_solved) || 0;
    const overallProgress = total ? Math.min(100, solved * 100 / total) : 0;
    const body = createCodingElement("div", "leetcode-stats-layout");
    const ringPanel = createCodingElement("article", "leetcode-ring-panel");
    const ring = createCodingElement("div", "leetcode-solved-ring");
    ring.style.setProperty("--ring-progress", `${overallProgress}%`);
    ring.setAttribute("role", "img");
    ring.setAttribute("aria-label", `${solved} of ${total || "unknown"} problems solved`);
    const ringCenter = createCodingElement("div", "leetcode-ring-center");
    ringCenter.append(
        createCodingElement("strong", "", solved.toLocaleString()),
        createCodingElement("span", "", `/ ${total ? total.toLocaleString() : "—"}`),
        createCodingElement("small", "", "SOLVED"),
    );
    ring.append(ringCenter);
    ringPanel.append(ring, createCodingElement("p", "coding-ring-caption", "Problems solved"));

    const difficultyPanel = createCodingElement("article", "leetcode-breakdown-panel");
    difficultyPanel.append(createCodingElement("h4", "", "Problem breakdown"));
    for (const difficulty of ["easy", "medium", "hard"]) {
        const count = Number(snapshot[`${difficulty}_solved`]) || 0;
        const difficultyTotal = Number(totals[difficulty]) || 0;
        const progress = difficultyTotal ? Math.min(100, count * 100 / difficultyTotal) : 0;
        const row = createCodingElement("div", `leetcode-difficulty-row difficulty-${difficulty}`);
        const details = createCodingElement("div", "leetcode-difficulty-details");
        details.append(
            createCodingElement("span", "", difficulty[0].toUpperCase() + difficulty.slice(1)),
            createCodingElement("strong", "", `${count.toLocaleString()} / ${difficultyTotal ? difficultyTotal.toLocaleString() : "—"}`),
        );
        const track = createCodingElement("div", "leetcode-progress-track");
        const fill = createCodingElement("span", "");
        fill.style.width = `${progress}%`;
        track.append(fill);
        row.append(details, track);
        difficultyPanel.append(row);
    }

    const languagePanel = createCodingElement("article", "leetcode-languages-panel");
    const languageHeading = createCodingElement("div", "coding-subsection-heading");
    languageHeading.append(
        createCodingElement("h4", "", "Languages Solved"),
        createCodingElement("span", "", "BY PROBLEMS"),
    );
    languagePanel.append(languageHeading);
    const languages = Array.isArray(extra.languages_solved) ? extra.languages_solved : [];
    if (!languages.length) {
        languagePanel.append(createCodingElement("p", "coding-empty-inline", "No language breakdown available."));
    } else {
        const list = createCodingElement("ul", "leetcode-language-list");
        for (const language of [...languages].sort((left, right) => right.problems_solved - left.problems_solved).slice(0, 6)) {
            const item = createCodingElement("li", "");
            item.append(
                createCodingElement("span", "", language.language_name),
                createCodingElement("strong", "", Number(language.problems_solved).toLocaleString()),
            );
            list.append(item);
        }
        languagePanel.append(list);
    }
    body.append(ringPanel, difficultyPanel, languagePanel);
    leetcodeProfileContent.append(body);
}

async function loadCodingProfiles() {
    try {
        const [profilesResult, snapshotsResult] = await Promise.all([
            getJson("/api/coding-profiles"),
            getJson("/api/coding-profiles/snapshot"),
        ]);
        codingProfileForm.elements.leetcode_url.value = profilesResult.profiles.leetcode.profile_url || "";
        const leetcodeProfile = snapshotsResult.snapshots.leetcode;
        codingProfileSnapshots = snapshotsResult.snapshots;
        renderLeetcodeProfile(leetcodeProfile);
        updateCodingLastSynced();
    } catch (error) {
        codingProfileMessage.textContent = error.message;
        codingProfileMessage.hidden = false;
    }
}

async function refreshCodingSnapshots() {
    try {
        const result = await getJson("/api/coding-profiles/snapshot");
        codingProfileSnapshots = result.snapshots;
        renderLeetcodeProfile(result.snapshots.leetcode);
        updateCodingLastSynced();
    } catch (error) {
        codingProfileMessage.textContent = error.message;
        codingProfileMessage.hidden = false;
    }
}

function showCodingToast(message) {
    const toast = createCodingElement("p", "coding-toast", message);
    codingToastRegion.replaceChildren(toast);
    window.setTimeout(() => toast.remove(), 9000);
}

async function showPendingCodingNotifications() {
    try {
        const result = await getJson("/api/coding-profiles/notifications");
        for (const notification of result.notifications) {
            showCodingToast(notification.message);
        }
    } catch (error) {
        codingProfileMessage.textContent = error.message;
        codingProfileMessage.hidden = false;
    }
}

async function saveCodingProfiles(event) {
    event.preventDefault();
    const button = codingProfileForm.querySelector("button[type='submit']");
    button.disabled = true;
    codingProfileMessage.hidden = true;
    try {
        const response = await fetch("/api/coding-profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                leetcode_url: codingProfileForm.elements.leetcode_url.value,
            }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to save coding profiles.");
        }
        codingProfileMessage.textContent = "Profile links saved.";
        codingProfileMessage.hidden = false;
        await loadCodingProfiles();
    } catch (error) {
        codingProfileMessage.textContent = error.message;
        codingProfileMessage.hidden = false;
    } finally {
        button.disabled = false;
    }
}

async function syncLeetcode() {
    localCodingSyncPlatform = "leetcode";
    updateCodingLastSynced();
    codingSyncButton.disabled = true;
    codingProfileMessage.textContent = "Syncing LeetCode stats...";
    codingProfileMessage.hidden = false;
    try {
        const response = await fetch("/api/sync/leetcode", { method: "POST" });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to sync LeetCode stats.");
        }
        await refreshCodingSnapshots();
        codingProfileMessage.textContent = `Synced LeetCode profile @${result.username}.`;
    } catch (error) {
        await refreshCodingSnapshots();
        codingProfileMessage.textContent = error.message;
    } finally {
        codingProfileMessage.hidden = false;
        localCodingSyncPlatform = null;
        updateCodingLastSynced();
        codingSyncButton.disabled = false;
    }
}

function updateCodingLastSynced() {
    const profile = codingProfileSnapshots.leetcode;
    const isSyncing = Boolean(profile?.is_syncing) || localCodingSyncPlatform === "leetcode";
    codingSyncSpinner.hidden = !isSyncing;
    if (profile?.last_sync_error) {
        const cachedStatus = profile.snapshot
            ? `Last synced: ${formatDateTime(profile.last_synced_at)} (sync failed on last attempt, showing cached data)`
            : "Sync failed on last attempt; no cached stats available yet";
        codingLastSynced.textContent = `Last checked: ${profile.last_checked_at ? formatTimeAgo(profile.last_checked_at) : "just now"}; ${cachedStatus}`;
        return;
    }
    codingLastSynced.textContent = profile?.last_checked_at
        ? `Last checked: ${formatTimeAgo(profile.last_checked_at)}`
        : "Last checked: Not yet";
}

function formatTimeAgo(value) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (elapsedSeconds < 60) {
        return "just now";
    }
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes} min${elapsedMinutes === 1 ? "" : "s"} ago`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}

function renderCharts(data) {
    if (!window.Chart) {
        document.querySelectorAll(".chart-panel").forEach((panel) => {
            const message = document.createElement("p");
            message.className = "chart-error";
            message.textContent = "Charts could not be loaded. Check your internet connection and refresh.";
            panel.querySelector(".chart-frame").replaceChildren(message);
        });
        return;
    }

    const textColor = "#a5afbd";
    const gridColor = "rgba(165, 175, 189, 0.13)";
    const dailyContext = document.querySelector("#daily-chart").getContext("2d");
    const dailyGradient = dailyContext.createLinearGradient(0, 0, 0, 300);
    dailyGradient.addColorStop(0, "rgba(85, 214, 208, 0.28)");
    dailyGradient.addColorStop(1, "rgba(85, 214, 208, 0.01)");

    new Chart(dailyContext, {
        type: "line",
        data: {
            labels: data.daily_study_hours.labels.map(formatDate),
            datasets: [{
                data: data.daily_study_hours.values,
                borderColor: "#55d6d0",
                backgroundColor: dailyGradient,
                fill: true,
                tension: 0.32,
                pointRadius: 2,
                pointHoverRadius: 5,
                pointBackgroundColor: "#55d6d0",
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: "index" },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => `${durationFormatter.format(context.parsed.y)} hours`,
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: textColor, maxTicksLimit: 7, maxRotation: 0 },
                    grid: { display: false },
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: textColor, precision: 0 },
                    grid: { color: gridColor },
                },
            },
        },
    });

    const domainNames = Object.keys(data.domain_split);
    new Chart(document.querySelector("#domain-chart"), {
        type: "pie",
        data: {
            labels: domainNames,
            datasets: [{
                data: domainNames.map((name) => data.domain_split[name] / 3600),
                backgroundColor: ["#55d6d0", "#f3b94f"],
                borderColor: "#171b22",
                borderWidth: 4,
                hoverOffset: 8,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: "bottom",
                    labels: { color: textColor, padding: 20, usePointStyle: true, pointStyle: "circle" },
                },
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.label}: ${durationFormatter.format(context.parsed)} hours`,
                    },
                },
            },
        },
    });
}

function renderTechnologyCharts(domains) {
    technologyChartGrid.replaceChildren();
    if (!window.Chart) {
        const message = document.createElement("p");
        message.className = "chart-error";
        message.textContent = "Charts could not be loaded. Check your internet connection and refresh.";
        technologyChartGrid.append(message);
        return;
    }

    for (const domain of domains) {
        const panel = document.createElement("article");
        panel.className = "technology-chart-panel";
        const heading = document.createElement("h3");
        heading.textContent = domain.domain_name;
        panel.append(heading);
        technologyChartGrid.append(panel);

        const technologies = [...domain.chart_technologies].sort(
            (left, right) => right.study_seconds - left.study_seconds,
        );

        const groups = domain.domain_name === "SDE"
            ? ["Frontend", "Backend", "General"].map((category) => ({
                category,
                technologies: technologies.filter((technology) => (technology.category || "General") === category),
            }))
            : [{ category: null, technologies }];
        for (const group of groups) {
            if (group.technologies.length === 0) {
                continue;
            }
            const groupContainer = document.createElement("div");
            groupContainer.className = domain.domain_name === "SDE" ? "technology-chart-group" : "";
            if (group.category) {
                const groupHeading = document.createElement("h4");
                groupHeading.textContent = group.category;
                groupContainer.append(groupHeading);
            }
            const frame = document.createElement("div");
            frame.className = "technology-chart-frame";
            frame.style.height = `${Math.max(150, group.technologies.length * 30)}px`;
            const canvas = document.createElement("canvas");
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", `${domain.domain_name}${group.category ? ` ${group.category}` : ""} study hours by technology`);
            frame.append(canvas);
            groupContainer.append(frame);
            panel.append(groupContainer);

            new Chart(canvas, {
            type: "bar",
            data: {
                labels: group.technologies.map((technology) => technology.technology_name),
                datasets: [{
                    data: group.technologies.map((technology) => technology.study_seconds / 3600),
                    backgroundColor: group.technologies.map((technology, index) =>
                        index === 0 ? "#55d6d0" : "rgba(85, 214, 208, 0.48)"),
                    borderRadius: 4,
                    borderSkipped: false,
                    barPercentage: 0.72,
                    categoryPercentage: 0.8,
                }],
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (context) => `${durationFormatter.format(context.parsed.x)} hours`,
                        },
                    },
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: { color: "#a5afbd" },
                        grid: { color: "rgba(165, 175, 189, 0.13)" },
                    },
                    y: {
                        ticks: { color: "#d8e0e8", autoSkip: false },
                        grid: { display: false },
                    },
                },
            },
        });
        }
    }
}

function createLearningTopic(technology) {
    const topic = document.createElement("article");
    topic.className = "learning-topic";

    const heading = document.createElement("div");
    heading.className = "learning-topic-heading";
    const name = document.createElement("h3");
    name.textContent = technology.technology_name;
    const completion = document.createElement("span");
    completion.className = "learning-topic-check";
    const isComplete = technology.target_seconds !== null
        && technology.study_seconds >= technology.target_seconds;
    completion.textContent = isComplete ? "Complete" : "";
    completion.setAttribute("aria-label", isComplete ? "Target reached" : "Target not reached");
    heading.append(name, completion);

    const details = document.createElement("div");
    details.className = "learning-topic-details";
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = technology.progress_percent;
    progress.setAttribute("aria-label", `${technology.technology_name} target progress`);
    const studied = document.createElement("span");
    studied.className = "learning-topic-hours";
    studied.textContent = technology.target_hours
        ? `${durationFormatter.format(technology.study_seconds / 3600)} / ${durationFormatter.format(technology.target_hours)} hours`
        : `${durationFormatter.format(technology.study_seconds / 3600)} hours studied · no target`;
    details.append(progress, studied);

    const targetForm = document.createElement("form");
    targetForm.className = "technology-target-form";
    targetForm.dataset.technologyId = technology.technology_id;
    const input = document.createElement("input");
    input.type = "number";
    input.name = "target_hours";
    input.min = "0.25";
    input.max = "24";
    input.step = "0.25";
    input.required = true;
    input.inputMode = "decimal";
    input.placeholder = "Target h";
    input.value = technology.target_hours ?? "";
    input.setAttribute("aria-label", `${technology.technology_name} target hours`);
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "dashboard-button dashboard-button-quiet";
    save.textContent = "Save";
    targetForm.append(input, save);

    topic.append(heading, details, targetForm);
    return topic;
}

function createDsaLearningStep(technology, index) {
    const status = technology.study_seconds === 0
        ? "Not started"
        : technology.target_seconds !== null && technology.study_seconds >= technology.target_seconds
            ? "Done"
            : "In progress";
    const step = document.createElement("li");
    step.className = "dsa-learning-step";
    step.dataset.status = status.toLowerCase().replaceAll(" ", "-");
    const marker = document.createElement("span");
    marker.className = "dsa-step-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = status === "Done" ? "✓" : String(index + 1);

    const topic = createLearningTopic(technology);
    topic.classList.add("dsa-step-card");
    const completion = topic.querySelector(".learning-topic-check");
    if (completion) {
        completion.remove();
    }
    const statusLabel = document.createElement("span");
    statusLabel.className = "dsa-step-status";
    statusLabel.textContent = status;
    topic.querySelector(".learning-topic-heading").append(statusLabel);
    step.append(marker, topic);
    return step;
}

async function loadLearningPath(domainId) {
    learningPathMessage.hidden = true;
    learningCoverage.textContent = "Loading topic progress...";
    try {
        const result = await getJson(`/api/technology-progress?domain_id=${encodeURIComponent(domainId)}`);
        learningPathList.replaceChildren();
        if (result.domain_name === "DSA") {
            const stepper = document.createElement("ol");
            stepper.className = "dsa-learning-stepper";
            const orderedTopics = [...result.technologies].sort((left, right) => left.sort_order - right.sort_order);
            stepper.append(...orderedTopics.map(createDsaLearningStep));
            learningPathList.append(stepper);
        } else if (result.domain_name === "SDE") {
            learningPathList.classList.remove("dsa-learning-path");
            for (const category of ["Frontend", "Backend", "General"]) {
                const technologies = result.technologies.filter(
                    (technology) => (technology.category || "General") === category,
                );
                if (technologies.length === 0) {
                    continue;
                }
                const group = document.createElement("section");
                group.className = "learning-category-group";
                const heading = document.createElement("h3");
                heading.textContent = category;
                const topics = document.createElement("div");
                topics.className = "learning-category-topics";
                topics.append(...technologies.map(createLearningTopic));
                group.append(heading, topics);
                learningPathList.append(group);
            }
        } else {
            learningPathList.classList.remove("dsa-learning-path");
            learningPathList.append(...result.technologies.map(createLearningTopic));
        }
        learningPathList.classList.toggle("dsa-learning-path", result.domain_name === "DSA");
        learningCoverage.textContent = `You've covered ${result.covered_count} of ${result.technology_count} ${result.domain_name} technologies.`;
    } catch (error) {
        learningPathList.replaceChildren();
        learningCoverage.textContent = "";
        learningPathMessage.textContent = error.message;
        learningPathMessage.hidden = false;
    }
}

async function saveTechnologyTarget(form) {
    const input = form.querySelector("[name='target_hours']");
    const saveButton = form.querySelector("button");
    saveButton.disabled = true;
    learningPathMessage.hidden = true;
    try {
        const response = await fetch("/api/technology-targets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                technology_id: Number(form.dataset.technologyId),
                target_hours: Number(input.value),
            }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to save the target.");
        }
        await loadLearningPath(learningDomainSelect.value);
    } catch (error) {
        learningPathMessage.textContent = error.message;
        learningPathMessage.hidden = false;
    } finally {
        saveButton.disabled = false;
    }
}

async function loadDashboard() {
    try {
        const data = await getJson("/api/dashboard");
        document.querySelector("#today-total").textContent = formatDuration(data.today_study_seconds);
        document.querySelector("#week-total").textContent = formatDuration(data.week_study_seconds);
        document.querySelector("#month-total").textContent = formatDuration(data.month_study_seconds);
        document.querySelector("#data-analyst-total").textContent = formatDuration(data.domain_split["Data Analyst"] || 0);
        document.querySelector("#sde-total").textContent = formatDuration(data.domain_split.SDE || 0);
        document.querySelector("#streak-total").textContent = String(data.streak_days);
        renderCharts(data);
        renderTechnologyCharts(data.technology_breakdown);
    } catch (error) {
        dashboardMessage.textContent = error.message;
        dashboardMessage.hidden = false;
    }
}

loadDashboard();
loadCodingProfiles();
showPendingCodingNotifications();
window.setInterval(refreshCodingSnapshots, 30000);
codingProfileForm.addEventListener("submit", saveCodingProfiles);
codingSyncButton.addEventListener("click", syncLeetcode);
learningDomainSelect.addEventListener("change", () => loadLearningPath(learningDomainSelect.value));
learningPathList.addEventListener("submit", (event) => {
    const form = event.target.closest(".technology-target-form");
    if (!form) {
        return;
    }
    event.preventDefault();
    saveTechnologyTarget(form);
});
loadLearningPath(learningDomainSelect.value);
