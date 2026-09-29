"use client";

import { loginBodySchema, type LoginBody } from "@lingumentor/shared-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { login } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { useAuthStore } from "@/store/auth-store";

export default function LoginPage() {
	const router = useRouter();
	const setSession = useAuthStore((s) => s.setSession);

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<LoginBody>({
		resolver: zodResolver(loginBodySchema),
		defaultValues: { email: "", password: "" },
	});

	const mutation = useMutation({
		mutationFn: login,
		onSuccess: (session) => {
			setSession(session.access_token, session.user);
			router.push("/dashboard");
		},
		onError: (err: Error) => {
			// INVALID_CREDENTIALS is identical for both causes (auth.service.ts,
			// no enum signal), so don't attribute it to one field.
			if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
				toast.error("Incorrect email or password.");
				return;
			}
			toast.error(err.message || "Sign in failed — please try again.");
		},
	});

	return (
		<AuthShell
			title="Welcome back"
			description="Sign in to continue your exam preparation."
			footer={
				<>
					New to LinguaMentor?{" "}
					<Link href="/register" className="font-medium text-primary hover:underline">
						Create an account
					</Link>
				</>
			}
		>
			<form
				onSubmit={handleSubmit((values) => mutation.mutate(values))}
				className="space-y-4"
				noValidate
			>
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						type="email"
						autoComplete="email"
						placeholder="you@example.com"
						{...register("email")}
					/>
					{errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<Label htmlFor="password">Password</Label>
						{/* No reset link: PATCH /auth/password lands in Phase 2. */}
					</div>
					<PasswordInput id="password" autoComplete="current-password" {...register("password")} />
					{errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
				</div>

				<Button type="submit" className="w-full" isLoading={mutation.isPending}>
					Sign in <ArrowRight className="h-4 w-4" />
				</Button>
			</form>
		</AuthShell>
	);
}
