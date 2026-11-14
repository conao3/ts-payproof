import type { CodegenConfig } from "@graphql-codegen/cli"
export default {
  schema: "schema.graphql",
  generates: {
    "apps/api/src/generated/resolvers.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        useTypeImports: true,
        contextType: "../graphql.ts#GraphQLContext",
        mappers: {
          Invoice: "../../../../packages/core/src/model.ts#Invoice",
          Vendor: "../../../../packages/core/src/model.ts#Vendor",
          Payment: "../../../../packages/core/src/model.ts#Payment",
        },
      },
    },
    "apps/web/src/graphql/generated/": {
      documents: "apps/web/src/graphql/operations.graphql",
      preset: "client",
      presetConfig: { fragmentMasking: { unmaskFunctionName: "getFragmentData" } },
      config: { useTypeImports: true },
    },
  },
} satisfies CodegenConfig
