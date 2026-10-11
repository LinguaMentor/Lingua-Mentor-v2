import * as Sentry from "@sentry/nextjs";

import { browserMonitoringOptions } from "@/lib/monitoring";

Sentry.init(browserMonitoringOptions(window.location.hostname));
