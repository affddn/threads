import { z } from "zod";

export const Mode = z.enum(["lite", "full"]).default("full");
