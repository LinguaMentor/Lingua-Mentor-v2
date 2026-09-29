import {
	LayoutDashboard,
	Mic,
	NotebookPen,
	Settings,
	Target,
	Timer,
	type LucideIcon,
} from "lucide-react";

export interface NavItem {
	href: string;
	label: string;
	icon: LucideIcon;
	/** "soon" renders disabled with a badge — better than linking to an unbuilt
	 * stub for Phase 2/3 features (Voice Agent, Exam Simulation). */
	status: "live" | "soon";
}

export const NAV_ITEMS: NavItem[] = [
	{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, status: "live" },
	{ href: "/placement", label: "Placement Test", icon: Target, status: "live" },
	{ href: "/practice/writing", label: "Writing Practice", icon: NotebookPen, status: "live" },
	{ href: "/practice/voice", label: "Voice Practice", icon: Mic, status: "soon" },
	{ href: "/practice/exam-simulation", label: "Exam Simulation", icon: Timer, status: "soon" },
];

export const SETTINGS_ITEM: NavItem = {
	href: "/settings",
	label: "Settings",
	icon: Settings,
	status: "soon",
};
