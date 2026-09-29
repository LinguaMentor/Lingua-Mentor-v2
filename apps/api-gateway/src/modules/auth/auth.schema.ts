// Register/login bodies, shared so the frontend forms validate on the same
// rules. Refresh and logout take no body — the token rides in a cookie.
export {
	loginBodySchema,
	type LoginBody,
	registerBodySchema,
	type RegisterBody,
} from "@lingumentor/shared-schemas";
