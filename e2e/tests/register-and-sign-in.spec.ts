import { expect, test } from "@playwright/test";

test("a new learner registers, signs out, signs back in and reaches the dashboard", async ({
	page,
}) => {
	const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
	const password = "correct-horse-battery";
	const dashboardHeading = page.getByRole("heading", { level: 1, name: "Welcome back, Ada" });

	await page.goto("/register");
	await page.getByLabel("Full name").fill("Ada Lovelace");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByLabel("Target exam").selectOption({ label: "IELTS Academic" });
	await page.getByRole("button", { name: "Create account" }).click();

	await expect(page).toHaveURL(/\/dashboard$/);
	await expect(dashboardHeading).toBeVisible();

	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login$/);

	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();

	await expect(page).toHaveURL(/\/dashboard$/);
	await expect(dashboardHeading).toBeVisible();
});
