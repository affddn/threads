import { z } from "zod";

export const MAX_GRANTED_PATHS = 16;
export const GrantedPaths = z.array(z.string().min(1).max(4096)).max(MAX_GRANTED_PATHS);
