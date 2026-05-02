/**
 * On-screen-keyboard handling for modals.
 *
 * Obsidian modals are positioned with `top: 50%; transform: translate(-50%, -50%)`
 * relative to the layout viewport. On mobile, when an input is focused the
 * on-screen keyboard appears and shrinks the *visual* viewport from the
 * bottom (and on Android sometimes pushes content with `offsetTop > 0`),
 * but the layout viewport doesn't change — so the modal stays centred over
 * a now-invisible region. Inputs near the bottom can end up behind the
 * keyboard.
 *
 * This helper listens to the `visualViewport` API and, while the keyboard
 * is up, repositions the modal to sit just below the visible area's top,
 * with `max-height` clamped to the available space. When the keyboard
 * dismisses, original styles are restored. No-ops on platforms without
 * `visualViewport` (no harm done — desktop never needed the adjustment).
 */
export function trackVisualViewportForModal(
	modalEl: HTMLElement
): () => void {
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const reset = () => {
		modalEl.style.top = "";
		modalEl.style.transform = "";
		modalEl.style.maxHeight = "";
	};

	const update = () => {
		// `obscured` is the portion of the layout viewport that the visual
		// viewport doesn't cover — typically the keyboard. A small threshold
		// avoids reacting to scrollbar / address-bar fluctuations.
		const obscured = window.innerHeight - vv.height - vv.offsetTop;
		if (obscured > 50) {
			modalEl.style.top = `${vv.offsetTop + 16}px`;
			modalEl.style.transform = "translateX(-50%)";
			modalEl.style.maxHeight = `${Math.max(0, vv.height - 32)}px`;
		} else {
			reset();
		}
	};

	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();

	return () => {
		vv.removeEventListener("resize", update);
		vv.removeEventListener("scroll", update);
		reset();
	};
}
