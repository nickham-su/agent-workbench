import type { DashboardQuerySuccessResponse } from "@agent-workbench/shared";

type ConfiguredProvider = {
  id: string;
  name: string;
  models: ReadonlyArray<{ id: string; name: string }>;
};

/** Add current configuration labels without changing the historical ID dimensions. */
export function withConfiguredModelNames(
  response: DashboardQuerySuccessResponse,
  providers: ReadonlyArray<ConfiguredProvider>,
): DashboardQuerySuccessResponse {
  const byModel = response.data.model.byModel;
  if (byModel.status === "unavailable" || byModel.data.length === 0) return response;

  const names = new Map<string, { providerName: string; models: Map<string, string> }>();
  for (const provider of providers) {
    names.set(provider.id, {
      providerName: provider.name.trim(),
      models: new Map(provider.models.map((model) => [model.id, model.name.trim()])),
    });
  }

  return {
    ...response,
    data: {
      ...response.data,
      model: {
        ...response.data.model,
        byModel: {
          ...byModel,
          data: byModel.data.map((row) => {
            const match = names.get(row.provider);
            const providerName = match?.providerName;
            const modelName = match?.models.get(row.model);
            return {
              ...row,
              ...(providerName ? { providerName } : {}),
              ...(modelName ? { modelName } : {}),
            };
          }),
        },
      },
    },
  };
}
