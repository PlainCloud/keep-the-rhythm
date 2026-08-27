import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import jsep from "jsep";
import { weekdaysNames, monthNames } from "../texts";
import {
	debounce,
	getDateForCell,
	getHeatmapWindow,
	sumTimeEntries,
} from "@/utils/utils";
import { formatDate } from "@/utils/dateUtils";
import { DailyActivity } from "@/db/types";
import { Unit, HeatmapColorModes, HeatmapConfig } from "@/defs/types";
import { HeatmapCell } from "./HeatmapCell";
import { Tooltip } from "./Tooltip";
import { compileEvaluator } from "@/core/codeBlockQuery";
import { getDB } from "@/db/db";
import { setIcon } from "obsidian";

interface HeatmapProps {
	heatmapConfig: HeatmapConfig;
	preferredUnit?: Unit;
	query?: jsep.Expression;
	isCodeBlock?: boolean;
}

export const Heatmap = ({
	heatmapConfig,
	preferredUnit = Unit.WORD,
	query,
	isCodeBlock,
}: HeatmapProps) => {
	const [unit, setUnit] = useState<Unit>(preferredUnit);
	const [hoveredMonth, setHoveredMonth] = useState<number | null>(null);
	const [hoveredWeekday, setHoveredWeekday] = useState<number | null>(null);

	// Sidebar heatmaps always fit their container width; code blocks use
	// the DAYS/WEEKS options instead
	const fitToWidth = !isCodeBlock;
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [availableWidth, setAvailableWidth] = useState<number | null>(null);

	// Roll the window forward when the day changes while Obsidian stays open
	// (upstream removed the timer-based date trigger, but a rolling window
	// needs to re-render at midnight to keep "today" as the last column).
	const [, setNowTick] = useState(0);
	useEffect(() => {
		let lastDay = new Date().getDate();
		const id = window.setInterval(() => {
			const currentDay = new Date().getDate();
			if (currentDay !== lastDay) {
				lastDay = currentDay;
				setNowTick((tick) => tick + 1);
			}
		}, 30000);
		return () => window.clearInterval(id);
	}, []);

	useEffect(() => {
		setUnit(preferredUnit);
	}, [preferredUnit]);

	let weeksOverride: number | undefined;
	if (fitToWidth && availableWidth !== null) {
		// Wrapper padding (16px) + border (2px) + weekday label space (32px)
		const labelSpace = heatmapConfig.hideWeekdayLabels ? 0 : 32;
		const usable = availableWidth - 18 - labelSpace;
		// Each column is 10px wide with a 2px gap: n*10 + (n-1)*2 = n*12 - 2
		weeksOverride = Math.max(1, Math.floor((usable + 2) / 12));
	}

	const { windowStart, windowEnd, weeksToShow } = getHeatmapWindow(
		heatmapConfig,
		weeksOverride,
	);

	const startDateStr = formatDate(windowStart);
	const endDateStr = formatDate(windowEnd);

	const heatmapData = useLiveQuery(async () => {
		const requiredDates = new Set<string>();

		for (let week = 0; week < weeksToShow; week++) {
			for (let day = 0; day < 7; day++) {
				const date = getDateForCell(week, day, weeksToShow);
				const dateStr = formatDate(date);

				// Days outside the rolling window render as empty cells,
				// no need to query them
				if (dateStr >= startDateStr && dateStr <= endDateStr) {
					requiredDates.add(dateStr);
				}
			}
		}

		let results: DailyActivity[] | null;
		let filterFn: ((entry: DailyActivity) => boolean) | null = null;
		if (query) {
			try {
				filterFn = compileEvaluator(query);
			} catch (e) {
				console.error("Error compiling query:", e);
			}
		}

		if (
			query?.type == "BinaryExpression" &&
			query?.operator === "starts_with"
		) {
			const rightValue = query.right;
			const rawValue =
				typeof rightValue === "object" &&
				rightValue !== null &&
				"value" in rightValue
					? rightValue.value
					: undefined;
			let value = typeof rawValue === "string" ? rawValue : undefined;
			if (value !== undefined) {
				value = value.startsWith("/") ? value.substring(1) : value;
				results = await getDB()
					.dailyActivity.where("[filePath+date]")
					.between(
						[value, startDateStr],
						[value + "\uffff", endDateStr],
						true,
						true,
					)
					.toArray();
			} else {
				results = [];
			}
		} else if (query && filterFn) {
			results = await getDB()
				.dailyActivity.where("date")
				.anyOf([...requiredDates])
				.filter((entry) => {
					return filterFn(entry);
				})
				.toArray();
		} else {
			results = await getDB()
				.dailyActivity.where("date")
				.anyOf([...requiredDates])
				.toArray();
		}

		const dateMap: Record<string, number> = {};

		for (const entry of results) {
			const entryValue = sumTimeEntries(entry, unit, true);
			const valueUntilNow = dateMap[entry.date] || 0;
			dateMap[entry.date] = valueUntilNow + entryValue;
		}

		return dateMap;
	}, [unit, startDateStr, endDateStr, weeksToShow, query]);

	// Fit-to-width mode: measure the available width so the number of columns
	// shown fills the container, always keeping today as the last column.
	// Only runs once the wrapper is mounted (heatmapReady), otherwise the
	// measurement would never happen and the window would fall back to a
	// fixed number of days. Layout effect avoids a visible flash of the
	// fallback window before the first measurement.
	const heatmapReady = !!heatmapData;
	useLayoutEffect(() => {
		if (!fitToWidth || !wrapperRef.current) return;

		const container = wrapperRef.current.parentElement;
		if (!container) return;

		const measure = () => {
			setAvailableWidth(container.clientWidth);
		};

		measure(); // measure immediately, no debounce for the first pass
		const observer = new ResizeObserver(debounce(measure, 120));
		observer.observe(container);

		return () => observer.disconnect();
	}, [fitToWidth, heatmapReady]);

	if (!heatmapData) {
		return <div className="heatmap-loading">Loading heatmap...</div>; // Replace with spinner or skeleton
	}

	const getMonthLabels = () => {
		const labels = [];
		let lastMonth = -1;

		for (let week = 0; week < weeksToShow; week++) {
			const date = getDateForCell(week, 0, weeksToShow);

			const localDate = new Date(
				date.getTime() - date.getTimezoneOffset() * 60000,
			);
			const month = localDate.getMonth();
			const dayOfMonth = localDate.getDate();

			if (month !== lastMonth && dayOfMonth <= 7) {
				labels.push({
					month: monthNames[month],
					week: week,
				});
				lastMonth = month;
			}
		}
		return labels;
	};

	const monthLabels = getMonthLabels();
	const getMonthForWeek = (weekIndex: number) => {
		let monthIndex = 0;
		for (let index = 0; index < monthLabels.length; index++) {
			if (monthLabels[index].week <= weekIndex) monthIndex = index;
		}
		return monthIndex;
	};

	const wrapperClasses = `
		heatmap-wrapper 
		${heatmapConfig.hideWeekdayLabels ? "hide-weekday-labels" : ""}
		${heatmapConfig.hideMonthLabels ? "hide-month-labels" : ""}
		${heatmapConfig.alignLeft ? "align-left" : ""}
		${isCodeBlock ? "is-code-block-heatmap" : ""}
	`;

	return (
		<RadixTooltip.Provider
			delayDuration={0}
			skipDelayDuration={1000}
			disableHoverableContent
		>
			{heatmapData && (
				<div className="heatmap-container">
					<Tooltip content="Change Unit">
						<button
							className="KTR-min-button heatmap-unit-toggle"
							ref={(element) =>
								element && setIcon(element, "case-sensitive")
							}
							onClick={() =>
								setUnit((previous) =>
									previous === Unit.WORD
										? Unit.CHAR
										: Unit.WORD,
								)
							}
						/>
					</Tooltip>
					<div className={wrapperClasses} ref={wrapperRef}>
						{!heatmapConfig.hideWeekdayLabels && (
							<div className="week-day-labels">
								{weekdaysNames.map((day, dayIndex) => (
									<div
										key={day}
										className="week-day-label"
										onMouseEnter={() =>
											setHoveredWeekday(dayIndex)
										}
										onMouseLeave={() =>
											setHoveredWeekday(null)
										}
									>
										{day}
									</div>
								))}
							</div>
						)}
						<div className="heatmap-content">
							{!heatmapConfig.hideMonthLabels && (
								<div
									className="month-labels"
									style={{
										gridTemplateColumns: `repeat(${weeksToShow}, 10px)`,
									}}
								>
									{monthLabels.map(
										({ month, week }, monthIndex) => (
											<div
												key={`${month}-${week}`}
												className="month-label"
												style={{ gridColumn: week }}
												onMouseEnter={() =>
													setHoveredMonth(monthIndex)
												}
												onMouseLeave={() =>
													setHoveredMonth(null)
												}
											>
												{month}
											</div>
										),
									)}
								</div>
							)}
							<div className="heatmap-new-grid">
								{Array(weeksToShow)
									.fill(null)
									.map((_, weekIndex) => (
										<div
											key={weekIndex}
											className="heatmap-column"
										>
											{Array(7)
												.fill(null)
												.map((_, dayIndex) => {
													const date = getDateForCell(
														weekIndex,
														dayIndex,
														weeksToShow,
													);
													const dateStr =
														formatDate(date);

													// Days outside the rolling
													// window render as empty
													// placeholders
													if (
														dateStr < startDateStr ||
														dateStr > endDateStr
													) {
														return (
															<div
																key={dateStr}
																className="heatmap-square heatmap-square-empty"
															></div>
														);
													}

													const count =
														heatmapData[dateStr] ??
														0;
													return (
														<HeatmapCell
															key={dateStr}
															count={count}
															unit={unit}
															dimmed={
																(hoveredMonth !==
																	null &&
																	getMonthForWeek(
																		weekIndex,
																	) !==
																		hoveredMonth) ||
																(hoveredWeekday !==
																	null &&
																	dayIndex !==
																		hoveredWeekday)
															}
															date={dateStr}
															squared={
																!heatmapConfig.roundCells
															}
															intensity={getCellIntensityLevel(
																count,
																heatmapConfig,
															)}
															mode={
																heatmapConfig.intensityMode
															}
														/>
													);
												})}
										</div>
									))}
							</div>
						</div>
					</div>
				</div>
			)}
		</RadixTooltip.Provider>
	);
};

const getCellIntensityLevel = (
	count: number,
	heatmapConfig: HeatmapConfig,
): number => {
	if (
		!heatmapConfig ||
		!heatmapConfig.intensityStops ||
		!heatmapConfig.intensityMode
	) {
		return 0;
	}

	const { low, medium, high } = heatmapConfig.intensityStops;

	switch (heatmapConfig.intensityMode) {
		case HeatmapColorModes.GRADUAL:
		case HeatmapColorModes.LIQUID:
			if (count <= low) return 0;
			if (count >= high) return 100;

			return ((count - low) / (high - low)) * 100;

		case HeatmapColorModes.SOLID:
			return count >= low ? 4 : 0;

		case HeatmapColorModes.STOPS: {
			// Ensure thresholds are properly ordered
			const sortedThresholds = [low, medium, high].sort((a, b) => a - b);
			const [minThreshold, midThreshold, maxThreshold] = sortedThresholds;

			if (count <= 0) return 0;
			if (count < minThreshold) return 1;
			if (count < midThreshold) return 2;
			if (count < maxThreshold) return 3;
			return 4;
		}
		default:
			return 0;
	}
};
