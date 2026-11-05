import { Text } from "@earendil-works/pi-tui";
const help = new Text(`↑↓ choose · enter select · esc cancel · "Show the full rationale" expands without applying`,1,0).render(80);
console.log(help);
console.log("lines:", help.length);
const help2 = new Text(`↑↓ choose · enter select · esc cancel · "Show the full rationale" expands without applying`,1,0).render(120);
console.log(help2);
