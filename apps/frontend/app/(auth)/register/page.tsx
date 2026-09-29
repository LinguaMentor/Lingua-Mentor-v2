"use client";

import { registerBodySchema } from "@lingumentor/shared-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useExams } from "@/hooks/use-exams";
import { register as registerRequest } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { useAuthStore } from "@/store/auth-store";

// target_exam is optional in the shared contract, but with no profile-update
// endpoint yet this is the only place to set it — so require it here, locally.
const registerFormSchema = registerBodySchema.extend({
	target_exam: z.string().min(1, "Choose your target exam"),
});
type RegisterFormValues = z.infer<typeof registerFormSchema>;

export default function RegisterPage() {
	const router = useRouter();
	const setSession = useAuthStore((s) => s.setSession);
	const examsQuery = useExams();

	const {
		register,
		handleSubmit,
		watch,
		control,
		setValue,
		setError,
		formState: { errors },
	} = useForm<RegisterFormValues>({
		resolver: zodResolver(registerFormSchema),
		defaultValues: {
			target_language: "en",
			target_exam: "",
			email: "",
			password: "",
			display_name: "",
		},
	});

	const targetLanguage = watch("target_language");
	const examsForLanguage = (examsQuery.data ?? []).filter(
		(exam) => exam.language === targetLanguage,
	);

	const mutation = useMutation({
		mutationFn: registerRequest,
		onSuccess: (session) => {
			setSession(session.access_token, session.user);
			toast.success(`Welcome, ${session.user.display_name.split(" ")[0]}`);
			router.push("/dashboard");
		},
		onError: (err: Error) => {
			if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
				setError("email", { message: "An account with this email already exists" });
				return;
			}
			toast.error(err.message || "Registration failed — please try again.");
		},
	});

	return (
		<AuthShell
			title="Create your account"
			description="Start with a placement test — writing and speaking, scored against real exam rubrics."
			footer={
				<>
					Already have an account?{" "}
					<Link href="/login" className="font-medium text-primary hover:underline">
						Sign in
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
					<Label htmlFor="display_name">Full name</Label>
					<Input
						id="display_name"
						autoComplete="name"
						placeholder="Ada Lovelace"
						{...register("display_name")}
					/>
					{errors.display_name && (
						<p className="text-xs text-destructive">{errors.display_name.message}</p>
					)}
				</div>

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
					<Label htmlFor="password">Password</Label>
					<PasswordInput
						id="password"
						autoComplete="new-password"
						placeholder="At least 8 characters"
						{...register("password")}
					/>
					{errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
				</div>

				<div className="space-y-2">
					<Label>Target language</Label>
					<Controller
						control={control}
						name="target_language"
						render={({ field }) => (
							<SegmentedControl
								name="target_language"
								value={field.value}
								onChange={(value) => {
									field.onChange(value);
									// Clear the exam: a language switch makes the old pick mismatched.
									setValue("target_exam", "");
								}}
								options={[
									{ value: "en", label: "English" },
									{ value: "fr", label: "Français" },
								]}
							/>
						)}
					/>
				</div>

				<div className="space-y-2">
					<Label htmlFor="target_exam">Target exam</Label>
					<Controller
						control={control}
						name="target_exam"
						render={({ field }) => (
							<Select
								id="target_exam"
								disabled={examsQuery.isLoading}
								value={field.value}
								onChange={field.onChange}
							>
								<option value="" disabled>
									{examsQuery.isLoading
										? "Loading exams…"
										: examsForLanguage.length === 0
											? "No exams available for this language yet"
											: "Choose an exam"}
								</option>
								{examsForLanguage.map((exam) => (
									<option key={exam.exam_id} value={exam.exam_id}>
										{exam.display_name}
									</option>
								))}
							</Select>
						)}
					/>
					{errors.target_exam && (
						<p className="text-xs text-destructive">{errors.target_exam.message}</p>
					)}
					{examsQuery.isError && (
						<p className="text-xs text-destructive">
							Couldn&apos;t load the exam list — try refreshing.
						</p>
					)}
				</div>

				<Button type="submit" className="w-full" isLoading={mutation.isPending}>
					Create account <ArrowRight className="h-4 w-4" />
				</Button>
			</form>
		</AuthShell>
	);
}
