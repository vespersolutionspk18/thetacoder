import { bedrockProviderModule } from "@theta/ai/bedrock-provider";
import { registerBunOAuthFlows } from "@theta/ai/bun-oauth";
import { setBedrockProviderModule } from "@theta/ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

