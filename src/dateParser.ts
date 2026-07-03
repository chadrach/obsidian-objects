/**
 * Natural-language date parsing used by the @ menu for Daily Notes.
 *
 * All patterns support prefix matching so suggestions appear as the user
 * types rather than only after the full keyword is entered.
 */

// ---------- static lookup tables ----------

const WEEKDAYS: Record<string, number> = {
	sunday: 0, sun: 0,
	monday: 1, mon: 1,
	tuesday: 2, tue: 2, tues: 2,
	wednesday: 3, wed: 3,
	thursday: 4, thu: 4, thur: 4, thurs: 4,
	friday: 5, fri: 5,
	saturday: 6, sat: 6,
};

const WEEKDAY_FULL = [
	"sunday", "monday", "tuesday", "wednesday",
	"thursday", "friday", "saturday",
];

const MONTH_FULL = [
	"january", "february", "march", "april", "may", "june",
	"july", "august", "september", "october", "november", "december",
];
const MONTH_SHORT = [
	"jan", "feb", "mar", "apr", "may", "jun",
	"jul", "aug", "sep", "oct", "nov", "dec",
];
const MONTH_LABEL = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABEL = [
	"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// ---------- helpers ----------

function findMonthByPrefix(s: string): number | null {
	if (s.length < 3) return null;
	const shortIdx = MONTH_SHORT.indexOf(s);
	if (shortIdx >= 0) return shortIdx;
	const fullIdx = MONTH_FULL.indexOf(s);
	if (fullIdx >= 0) return fullIdx;
	const prefixIdx = MONTH_FULL.findIndex(m => m.startsWith(s));
	return prefixIdx >= 0 ? prefixIdx : null;
}

function findWeekdayByPrefix(s: string): number | null {
	if (s.length < 2) return null;
	if (WEEKDAYS[s] !== undefined) return WEEKDAYS[s];
	const idx = WEEKDAY_FULL.findIndex(d => d.startsWith(s));
	return idx >= 0 ? idx : null;
}

function atMidnight(d: Date): Date {
	const out = new Date(d);
	out.setHours(0, 0, 0, 0);
	return out;
}

function addDays(d: Date, n: number): Date {
	const out = new Date(d);
	out.setDate(out.getDate() + n);
	return out;
}

function weekdayRelative(now: Date, targetDow: number, modifier: string): Date {
	const base = atMidnight(now);
	const currentDow = base.getDay();
	let delta = targetDow - currentDow;
	if (modifier === "next") {
		delta = delta <= 0 ? delta + 7 : delta;
		if (delta === 0) delta = 7;
	} else if (modifier === "last") {
		delta = delta >= 0 ? delta - 7 : delta;
	} else {
		if (delta < 0) delta += 7;
	}
	return addDays(base, delta);
}

// Returns true if `s` is a prefix of `keyword` with at least `minLen` chars.
function prefixOf(s: string, keyword: string, minLen: number): boolean {
	return s.length >= minLen && keyword.startsWith(s);
}

// ---------- public types ----------

export interface ParsedDate {
	date: Date;
	/** Display-friendly description of what was matched. */
	label: string;
}

// ---------- main parser ----------

export function parseNaturalDate(input: string, now = new Date()): ParsedDate | null {
	const raw = input.trim().toLowerCase();
	if (!raw) return null;

	// ── 1. Keywords (prefix matching, min 3 chars) ──────────────────────────

	// "now" — exact only (2 chars, too short for safe prefix matching)
	if (raw === "now") {
		return { date: atMidnight(now), label: "today" };
	}
	// "today" — prefix "tod", "toda", "today"
	if (prefixOf(raw, "today", 3)) {
		return { date: atMidnight(now), label: "today" };
	}
	// "tomorrow" — prefix "tom", "tomo", …  also accept "tmr" / "tmrw"
	if (raw === "tmr" || raw === "tmrw" || prefixOf(raw, "tomorrow", 3)) {
		return { date: addDays(atMidnight(now), 1), label: "tomorrow" };
	}
	// "yesterday" — prefix "yes", "yest", …
	if (prefixOf(raw, "yesterday", 3)) {
		return { date: addDays(atMidnight(now), -1), label: "yesterday" };
	}

	// ── 2. Multi-word relative phrases (exact match only) ───────────────────

	if (raw === "last week") {
		// Monday of last week
		const base = atMidnight(now);
		const daysSinceMonday = (base.getDay() + 6) % 7;
		return { date: addDays(base, -(daysSinceMonday + 7)), label: "last week" };
	}
	if (raw === "next week") {
		const base = atMidnight(now);
		const daysUntilMonday = ((8 - base.getDay()) % 7) || 7;
		return { date: addDays(base, daysUntilMonday), label: "next week" };
	}
	if (raw === "last month") {
		return {
			date: new Date(now.getFullYear(), now.getMonth() - 1, 1),
			label: "last month",
		};
	}
	if (raw === "next month") {
		return {
			date: new Date(now.getFullYear(), now.getMonth() + 1, 1),
			label: "next month",
		};
	}
	if (raw === "last year") {
		return { date: new Date(now.getFullYear() - 1, 0, 1), label: "last year" };
	}
	if (raw === "next year") {
		return { date: new Date(now.getFullYear() + 1, 0, 1), label: "next year" };
	}

	// ── 3. ISO date YYYY-MM-DD ───────────────────────────────────────────────

	const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (iso) {
		const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
		if (!isNaN(d.getTime())) return { date: d, label: raw };
	}

	// ── 4. Numeric M/D, M/D/YY, M/D/YYYY ───────────────────────────────────

	const numeric = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
	if (numeric) {
		const month = Number(numeric[1]) - 1;
		const day = Number(numeric[2]);
		let year = now.getFullYear();
		if (numeric[3]) {
			year = Number(numeric[3]);
			if (year < 100) year += 2000;
		}
		if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
			const d = new Date(year, month, day);
			if (!isNaN(d.getTime()) && d.getDate() === day) {
				const label = numeric[3]
					? `${numeric[1]}/${numeric[2]}/${numeric[3]}`
					: `${numeric[1]}/${numeric[2]}`;
				return { date: d, label };
			}
		}
	}

	// ── 5. Relative ±N days/weeks, "in N days/weeks" ────────────────────────

	const rel = raw.match(/^([+-]?)(\d+)\s*(d|day|days|w|week|weeks)?$/);
	if (rel) {
		const sign = rel[1] === "-" ? -1 : 1;
		const n = Number(rel[2]);
		const unit = (rel[3] || "d").startsWith("w") ? 7 : 1;
		const plural = n === 1 ? "" : "s";
		return {
			date: addDays(atMidnight(now), sign * n * unit),
			label: `${sign < 0 ? "-" : "+"}${n} ${unit === 7 ? "week" : "day"}${plural}`,
		};
	}

	const inN = raw.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
	if (inN) {
		const n = Number(inN[1]);
		const unit = inN[2].startsWith("w") ? 7 : 1;
		return { date: addDays(atMidnight(now), n * unit), label: `in ${n} ${inN[2]}` };
	}

	// ── 6. "N days/weeks ago" ────────────────────────────────────────────────

	const ago = raw.match(/^(\d+)\s+(day|days|week|weeks)\s+ago$/);
	if (ago) {
		const n = Number(ago[1]);
		const unit = ago[2].startsWith("w") ? 7 : 1;
		return {
			date: addDays(atMidnight(now), -(n * unit)),
			label: `${n} ${ago[2]} ago`,
		};
	}

	// ── 7. Month-name dates: "[Month] [Day?,] [Year?]" ──────────────────────
	// Month name (3+ chars, prefix matching) optionally followed by day and year.

	const monthExpr = raw.match(/^([a-z]+)(?:\s+(\d{1,2}),?)?(?:\s+(\d{4}))?$/);
	if (monthExpr) {
		const monthIdx = findMonthByPrefix(monthExpr[1]);
		if (monthIdx !== null) {
			const day = monthExpr[2] ? Number(monthExpr[2]) : 1;
			const year = monthExpr[3] ? Number(monthExpr[3]) : now.getFullYear();
			const d = new Date(year, monthIdx, day);
			if (!isNaN(d.getTime()) && d.getDate() === day) {
				const label = monthExpr[2]
					? `${MONTH_LABEL[monthIdx]} ${day}, ${year}`
					: `${MONTH_LABEL[monthIdx]} 1, ${year}`;
				return { date: d, label };
			}
		}
	}

	// ── 8. Weekday with optional modifier (prefix matching, min 2 chars) ────

	const weekdayExpr = raw.match(/^(next|last|this)?\s*([a-z]+)$/);
	if (weekdayExpr) {
		const modifier = weekdayExpr[1] ?? "this";
		const dayIdx = findWeekdayByPrefix(weekdayExpr[2]);
		if (dayIdx !== null) {
			return {
				date: weekdayRelative(now, dayIdx, modifier),
				label: `${modifier} ${WEEKDAY_LABEL[dayIdx].toLowerCase()}`,
			};
		}
	}

	return null;
}

// ---------- date formatter ----------

/**
 * Format a date per a Moment-style format string. Supports the tokens used by
 * the Daily Notes core plugin's default format: YYYY, MM, DD, ddd, dddd, HH,
 * mm, ss, M, D.
 */
export function formatDate(date: Date, format: string): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	const monthShort = [
		"Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	];
	const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const weekdayLong = [
		"Sunday", "Monday", "Tuesday", "Wednesday",
		"Thursday", "Friday", "Saturday",
	];
	const replacements: Array<[RegExp, string]> = [
		[/YYYY/g, String(date.getFullYear())],
		[/YY/g, String(date.getFullYear()).slice(-2)],
		[/MMMM/g, monthShort[date.getMonth()]],
		[/MMM/g, monthShort[date.getMonth()]],
		[/MM/g, pad(date.getMonth() + 1)],
		[/(^|[^M])M(?!M)/g, `$1${date.getMonth() + 1}`],
		[/DD/g, pad(date.getDate())],
		[/(^|[^D])D(?!D)/g, `$1${date.getDate()}`],
		[/dddd/g, weekdayLong[date.getDay()]],
		[/ddd/g, weekdayShort[date.getDay()]],
		[/HH/g, pad(date.getHours())],
		[/mm/g, pad(date.getMinutes())],
		[/ss/g, pad(date.getSeconds())],
	];
	let out = format;
	for (const [re, val] of replacements) out = out.replace(re, val);
	return out;
}
