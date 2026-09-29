import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}
