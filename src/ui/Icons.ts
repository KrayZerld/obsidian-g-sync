const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Custom no-background geometric "G" monogram icon for the Obsidian Status Bar.
 * All standard UI icons use Obsidian's built-in Lucide `setIcon()` API.
 */
export function createStatusGIcon(size = 15): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2.1");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "svg-icon gsync-icon-g");

	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", "M18.5 8.2A7.5 7.5 0 1 0 19.5 12h-7");
	svg.appendChild(path);
	return svg;
}
