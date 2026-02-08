import { defineNuxtModule, addServerPlugin, addServerHandler, createResolver } from '@nuxt/kit';

export default defineNuxtModule({
    meta: { name: 'or3-provider-fs' },
    setup(_options: Record<string, unknown>, _nuxt: unknown) {
        const { resolve } = createResolver(import.meta.url);

        addServerPlugin(resolve('runtime/server/plugins/register'));

        addServerHandler({
            route: '/api/storage/fs/upload',
            method: 'put',
            handler: resolve('runtime/server/api/storage/fs/upload.put'),
        });

        addServerHandler({
            route: '/api/storage/fs/download',
            method: 'get',
            handler: resolve('runtime/server/api/storage/fs/download.get'),
        });
    },
});
