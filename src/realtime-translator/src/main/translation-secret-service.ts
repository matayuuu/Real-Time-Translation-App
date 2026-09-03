import { AzureCliCredential } from "@azure/identity";

import type {
  RealtimeTranslationContext,
  TranslationSecretRequest,
  TranslationSessionSecret,
} from "../shared/contracts";

const AZURE_REALTIME_SCOPE = "https://ai.azure.com/.default";
const REQUEST_TIMEOUT_MS = 15_000;

interface ClientSecretResponse {
  value?: unknown;
  expires_at?: unknown;
}

export class TranslationSecretService {
  private readonly credential = new AzureCliCredential();

  public async create(
    context: RealtimeTranslationContext,
    request: TranslationSecretRequest,
  ): Promise<TranslationSessionSecret> {
    const expectedLanguage = request.source === "speaker" ? "ja" : "en";
    if (request.targetLanguage !== expectedLanguage) {
      throw new Error(
        `Invalid target language for ${request.source}: ${request.targetLanguage}.`,
      );
    }

    const accessToken = await this.credential.getToken(AZURE_REALTIME_SCOPE);
    if (!accessToken?.token) {
      throw new Error(
        "Microsoft Entra token acquisition failed. Run az login and try again.",
      );
    }

    const endpoint = context.openai_endpoint.replace(/\/+$/, "");
    const response = await fetch(
      `${endpoint}/openai/v1/realtime/translations/client_secrets`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            model: context.translation.deployment_name,
            audio: {
              input: {
                transcription: {
                  model: context.transcription.deployment_name,
                },
                noise_reduction:
                  request.source === "microphone"
                    ? { type: "near_field" }
                    : null,
              },
              output: {
                language: request.targetLanguage,
              },
            },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const responseText = (await response.text()).slice(0, 500);
      throw new Error(
        `Foundry client-secret request failed (${response.status} ${response.statusText}): ${responseText}`,
      );
    }

    const payload = (await response.json()) as ClientSecretResponse;
    if (typeof payload.value !== "string" || payload.value === "") {
      throw new Error("Foundry client-secret response did not contain a value.");
    }

    const result: TranslationSessionSecret = {
      value: payload.value,
      endpoint,
    };
    if (typeof payload.expires_at === "number") {
      result.expiresAt = payload.expires_at;
    }
    return result;
  }
}
