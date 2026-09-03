# POE Ninja Quantity Calculator

A browser extension that calculates and displays total Increased Item Quantity (IIQ) on poe.ninja character profiles.

Available on the [Firefox Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/quant-calculator-for-poe-ninja/).

## Features

- **Total Quantity Calculation**: Computes cumulative Item Quantity from equipped gear, item modifiers, and support gems.
- **Detailed Breakdown**: Hover over the quantity stat to see an itemized list of all contributing sources with PoE rarity colors.
- **Pinnable Tooltip**: Press `Alt` or click the pin icon to keep the breakdown open.
- **Lightweight & Private**: Runs entirely in your browser with zero data collection or external requests.

## Installation

### Firefox

Install directly from the [Firefox Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/quant-calculator-for-poe-ninja/).

Alternatively, for manual loading:
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and select `manifest.json`.

### Chrome, Brave, Edge

1. Clone or download this repository.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the extension folder.

## Usage

1. Open any character profile on `poe.ninja/builds`.
2. Find **Item Quantity** in the Character stats table below **Item Rarity**.
3. Hover to view the source breakdown, or press `Alt` to pin the tooltip.

## License

MIT
