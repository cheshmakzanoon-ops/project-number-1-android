import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval("Expire calls, statuses and signaling", { minutes: 1 }, internal.maintenance.sweep, {});
crons.interval("Reclaim abandoned uploads and old budgets", { minutes: 15 }, internal.uploads.cleanup, {});
export default crons;
