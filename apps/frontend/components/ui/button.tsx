import { Slot } from "@radix-ui/react-slot";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
		"transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
		"focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
				secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
				outline: "border border-input bg-background shadow-sm hover:bg-secondary",
				ghost: "hover:bg-secondary hover:text-secondary-foreground",
				destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-10 px-4 py-2",
				sm: "h-9 rounded-md px-3 text-sm",
				lg: "h-11 rounded-md px-6 text-base",
				icon: "h-10 w-10",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	/** Spinner + disabled submit affordance; ignored under `asChild` (links have no pending state). */
	isLoading?: boolean;
	/** Style the child (e.g. next/link) as a button via Radix Slot — no nested interactive elements. */
	asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, isLoading, disabled, asChild, children, ...props }, ref) => {
		if (asChild) {
			return (
				<Slot ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props}>
					{children}
				</Slot>
			);
		}
		return (
			<button
				ref={ref}
				className={cn(buttonVariants({ variant, size, className }))}
				disabled={disabled || isLoading}
				{...props}
			>
				{isLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
				{children}
			</button>
		);
	},
);
Button.displayName = "Button";
