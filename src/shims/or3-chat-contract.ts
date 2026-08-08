/**
 * Standalone release contract fixture.
 *
 * Provider source is loaded by Nuxt at runtime, so these aliases intentionally
 * expose only the host shapes needed to compile this package. Keeping the
 * fixture in the provider checkout makes `type-check:standalone` reproducible
 * on a release runner that does not have a sibling `or3-chat` directory.
 */
export type StorageGatewayAdapter = any;
export type PresignUploadRequest = any;
export type PresignUploadResponse = any;
export type PresignDownloadRequest = any;
export type PresignDownloadResponse = any;
export type DeleteObjectRequest = any;
export type CanonicalStorageQueryKind = any;
export type ProviderAdminAdapter = any;
export type ProviderActionContext = any;
export type ProviderAdminStatusResult = any;
export type ProviderStatusContext = any;

export const requireCan = (..._args: any[]): any => undefined;
export const resolveSessionContext = async (..._args: any[]): Promise<any> => ({ authenticated: false });
export const getActiveSyncGatewayAdapter = (..._args: any[]): any => undefined;
export const registerStorageGatewayAdapter = (..._args: any[]): any => undefined;
export const registerProviderAdminAdapter = (..._args: any[]): any => undefined;
