/**
 * Natural-language date parsing used by the @ menu for Daily Notes.
 *
 * This is intentionally narrow and dependency-free: it handles the common
 * shortcuts ("today", "tomorrow", "yesterday", "next monday", "last friday",
 * "in 3 days", "+2d", ISO dates). For anything more ambitious we should pull
 * in chrono-node, but the plugin works fine without it.
 */

const WEEKDAYS: Record<string, number> = {
	sunday: 0,
	sun: 0,
	monday: 1,
	mon: 1,
	tuesday: 2,
	tue: 2,
	tues: 2,
	wednesday: 3,
	wed: 3,
	thursday: 4,
	thu: 4,
	thur: 4,
	thurs: 4,
	friday: 5,
	fri: 5,
	saturday: 6,
	sat: 6,
};

export interface ParsedDate {
	date: Date;
	/** Display-friendly echo of what was matched, e.g. "next tuesday". */
	label: string;
}

export function parseNaturalDate(input: string, now = new Date()): ParsedDate | null {
	const raw = input.trim().toLowerCase();
	if (!raw) return null;

	if (raw === "today" || raw === "now") {
		return { date: atMidnight(now), label: "today" };
	}
	if (raw === "tomorrow" || raw === "tmr" || raw === "tmrw") {
		return { date: addDays(atMidnight(now), 1), label: "tomorrow" };
	}
	if (raw === "yesterday") {
		return { date: addDays(atMidnight(now), -1), label: "yesterday" };
	}

	const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (iso) {
		const d = new Date(
			Number(iso[1]),
			Number(iso[2]) - 1,
			Number(iso[3])
		);
		if (!isNaN(d.getTime())) return { date: d, label: raw };
	}

	const rel = raw.match(/^([+-]?)(\d+)\s*(d|day|days|w|week|weeks)?$/);
	if (rel) {
		const sign = rel[1] === "-" ? -1 : 1;
		const n = Number(rel[2]);
		const unit = (rel[3] || "d").startsWith("w") ? 7 : 1;
		return {
			date: addDays(atMidnight(now), sign * n * unit),
			label: `${sign < 0 ? "-" : "+"}${n} ${unit === 7 ? "week" : "day"}${
				n === 1 ? "" : "s"
			}`,
		};
	}

	const inN = raw.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
	if (inN) {
		const n = Number(inN[1]);
		const unit = inN[2].startsWith("w") ? 7 : 1;
		return {
			date: addDays(atMidnight(now), n * unit),
			label: `in ${n} ${inN[2]}`,
		};
	}

	const weekdayRel = raw.match(/^(next|last|this)?\s*([a-z]+)$/);
	if (weekdayRel) {
		const modifier = weekdayRel[1] ?? "this";
		const day = WEEKDAYS[weekdayRel[2]];
		if (day !== undefined) {
			return {
				date: weekdayRelative(now, day, modifier),
				label: `${modifier} ${weekdayRel[2]}`,
			};
		}
	}

	return null;
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

function weekdayRelative(
	now: Date,
	targetDow: number,
	modifier: string
): Date {
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

/**
 * Format a date per a Moment-style format string. Supports the tokens used by
 * the Daily Notes core plugin's default format: YYYY, MM, DD, ddd, dddd, HH,
 * mm, ss, M, D.
 */
export function formatDate(date: Date, format: string): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const weekdayLong = [
		"Sunday",
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
	];
	const monthShort = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
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
