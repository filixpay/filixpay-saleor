import { SaleorApp } from "@saleor/app-sdk/saleor-app";
import { FileAPL } from "@saleor/app-sdk/APL/file";

export const saleorApp = new SaleorApp({
  apl: new FileAPL({
    fileName: process.env.FILE_APL_PATH,
  }),
});