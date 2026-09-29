import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const alertVariants = cva("relative flex gap-3 rounded-lg border p-4 text-sm", {
	variants: {
		variant: {
			default: "border-border bg-card text-card-foreground",
			info: "border-primary/20 bg-primary/5 text-foreground",
			success: "border-success/20 bg-success/5 text-foreground",
			warning: "border-warning/25 bg-warning/10 text-foreground",
			destructive: "border-destructive/25 bg-destructive/5 text-foreground",
		},
	},
	defaultVariants: { variant: "default" },
});

const ICONS = {
	default: Info,
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	destructive: XCircle,
} as const;

const ICON_COLORS = {
	default: "text-muted-foreground",
	info: "text-primary",
	success: "text-success",
	warning: "text-warning",
	destructive: "text-destructive",
} as const;

export interface AlertProps
	extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
	/** Render without the leading status icon — for compact inline usage. */
	hideIcon?: boolean;
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
	({ className, variant = "default", hideIcon, children, ...props }, ref) => {
		const Icon = ICONS[variant ?? "default"];
		return (
			<div ref={ref} role="status" className={cn(alertVariants({ variant }), className)} {...props}>
				{!hideIcon && (
					<Icon
						className={cn("mt-0.5 h-5 w-5 shrink-0", ICON_COLORS[variant ?? "default"])}
						aria-hidden="true"
					/>
				)}
				<div className="flex-1 space-y-1">{children}</div>
			</div>
		);
	},
);
Alert.displayName = "Alert";

export const AlertTitle = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLHeadingElement>>(
	({ className, ...props }, ref) => (
		<h5 ref={ref} className={cn("font-semibold leading-tight", className)} {...props} />
	),
);
AlertTitle.displayName = "AlertTitle";

export const AlertDescription = forwardRef<
	HTMLParagraphElement,
	HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
	<div ref={ref} className={cn("text-muted-foreground leading-relaxed", className)} {...props} />
));
AlertDescription.displayName = "AlertDescription";
