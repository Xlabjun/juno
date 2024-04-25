import type {
	_SERVICE as SatelliteActor,
	SetRule,
	StorageConfig
} from '$declarations/satellite/satellite.did';
import { idlFactory as idlFactorSatellite } from '$declarations/satellite/satellite.factory.did';
import { AnonymousIdentity } from '@dfinity/agent';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { arrayBufferToUint8Array, fromNullable, toNullable } from '@dfinity/utils';
import { PocketIc, type Actor } from '@hadronous/pic';
import { afterAll, beforeAll, beforeEach, describe, expect } from 'vitest';
import { ADMIN_ERROR_MSG, CONTROLLER_ERROR_MSG } from './constants/satellite-tests.constants';
import { WASM_PATH, satelliteInitArgs } from './utils/satellite-tests.utils';

describe('Satellite storage', () => {
	let pic: PocketIc;
	let actor: Actor<SatelliteActor>;

	const controller = Ed25519KeyIdentity.generate();

	beforeAll(async () => {
		pic = await PocketIc.create();

		const { actor: c } = await pic.setupCanister<SatelliteActor>({
			idlFactory: idlFactorSatellite,
			wasm: WASM_PATH,
			arg: satelliteInitArgs(controller),
			sender: controller.getPrincipal()
		});

		actor = c;
	});

	afterAll(async () => {
		await pic?.tearDown();
	});

	describe('anonymous', () => {
		beforeAll(() => {
			actor.setIdentity(new AnonymousIdentity());
		});

		it('should throw errors on setting custom domain', async () => {
			const { set_custom_domain } = actor;

			await expect(set_custom_domain('hello.com', toNullable())).rejects.toThrow(ADMIN_ERROR_MSG);
		});

		it('should throw errors on listing custom domains', async () => {
			const { list_custom_domains } = actor;

			await expect(list_custom_domains()).rejects.toThrow(ADMIN_ERROR_MSG);
		});

		it('should throw errors on deleting custom domains', async () => {
			const { del_custom_domain } = actor;

			await expect(del_custom_domain('hello.com')).rejects.toThrow(ADMIN_ERROR_MSG);
		});

		it('should throw errors on delete all assets', async () => {
			const { del_assets } = actor;

			await expect(del_assets('#dapp')).rejects.toThrow(CONTROLLER_ERROR_MSG);
		});

		it('should throw errors on setting config', async () => {
			const { set_config } = actor;

			await expect(
				set_config({
					storage: {
						headers: [],
						iframe: toNullable(),
						redirects: toNullable(),
						rewrites: []
					}
				})
			).rejects.toThrow(ADMIN_ERROR_MSG);
		});

		it('should throw errors on getting config', async () => {
			const { get_config } = actor;

			await expect(get_config()).rejects.toThrow(ADMIN_ERROR_MSG);
		});
	});

	describe('hacking', () => {
		const hacker = Ed25519KeyIdentity.generate();

		beforeEach(() => {
			actor.setIdentity(controller);
		});

		it('should throw errors on upload chunk to admin batch', async () => {
			const { init_asset_upload, upload_asset_chunk } = actor;

			const batch = await init_asset_upload({
				collection: '#dapp',
				description: toNullable(),
				encoding_type: [],
				full_path: '/hello.html',
				name: 'hello.html',
				token: toNullable()
			});

			actor.setIdentity(hacker);

			await expect(
				upload_asset_chunk({
					batch_id: batch.batch_id,
					content: [],
					order_id: [0n]
				})
			).rejects.toThrow('Bach initializer does not match chunk uploader.');
		});

		it('should throw errors on trying to commit admin batch', async () => {
			const { init_asset_upload, commit_asset_upload, upload_asset_chunk } = actor;

			const batch = await init_asset_upload({
				collection: '#dapp',
				description: toNullable(),
				encoding_type: [],
				full_path: '/hello.html',
				name: 'hello.html',
				token: toNullable()
			});

			const chunk = await upload_asset_chunk({
				batch_id: batch.batch_id,
				content: [],
				order_id: [0n]
			});

			actor.setIdentity(hacker);

			await expect(
				commit_asset_upload({
					batch_id: batch.batch_id,
					chunk_ids: [chunk.chunk_id],
					headers: []
				})
			).rejects.toThrow('Cannot commit batch.');
		});
	});

	describe('admin', () => {
		beforeAll(() => {
			actor.setIdentity(controller);
		});

		it('should set and get config', async () => {
			const { set_config, get_config } = actor;

			const storage: StorageConfig = {
				headers: [['*', [['Cache-Control', 'no-cache']]]],
				iframe: toNullable({ Deny: null }),
				redirects: [
					[
						[
							'/*',
							{
								location: '/hello.html',
								status_code: 302
							}
						]
					]
				],
				rewrites: [['/hello.html', '/hello.html']]
			};

			await set_config({
				storage
			});

			const configs = await get_config();

			expect(configs).toEqual({
				storage
			});
		});

		it('should deploy asset to dapp', async () => {
			const { http_request, commit_asset_upload, upload_asset_chunk, init_asset_upload } = actor;

			const file = await init_asset_upload({
				collection: '#dapp',
				description: toNullable(),
				encoding_type: [],
				full_path: '/hello.html',
				name: 'hello.html',
				token: toNullable()
			});

			const HTML = '<html><body>Hello</body></html>';

			const blob = new Blob([HTML], {
				type: 'text/plain; charset=utf-8'
			});

			const chunk = await upload_asset_chunk({
				batch_id: file.batch_id,
				content: arrayBufferToUint8Array(await blob.arrayBuffer()),
				order_id: [0n]
			});

			await commit_asset_upload({
				batch_id: file.batch_id,
				chunk_ids: [chunk.chunk_id],
				headers: []
			});

			const { headers, body } = await http_request({
				body: [],
				certificate_version: toNullable(),
				headers: [],
				method: 'GET',
				url: '/hello.html'
			});

			const rest = headers.filter(([header, _]) => header !== 'IC-Certificate');

			expect(rest).toEqual([
				['accept-ranges', 'bytes'],
				['etag', '"03ee66f1452916b4f91a504c1e9babfa201b6d64c26a82b2cf03c3ed49d91585"'],
				['X-Content-Type-Options', 'nosniff'],
				['Strict-Transport-Security', 'max-age=31536000 ; includeSubDomains'],
				['Referrer-Policy', 'same-origin'],
				['X-Frame-Options', 'DENY'],
				['Cache-Control', 'no-cache']
			]);

			const certificate = headers.find(([header, _]) => header === 'IC-Certificate');

			expect(certificate).not.toBeUndefined();

			const [_, value] = certificate as [string, string];
			expect(value.substring(value.indexOf('tree=:'))).toEqual(
				'tree=:2dn3gwGDAktodHRwX2Fzc2V0c4MBggRYIDmN5doHXoiKCtNGBOZIdmQ+WGqYjcmdRB1MPuJBK2oXgwJLL2hlbGxvLmh0bWyCA1ggA+5m8UUpFrT5GlBMHpur+iAbbWTCaoKyzwPD7UnZFYWCBFggu+vgJ40baoH6QaigqUGb3VrUkopUK4LJuugRxX7g6qc=:'
			);

			const decoder = new TextDecoder();
			expect(decoder.decode(body as ArrayBuffer)).toEqual(HTML);
		});

		describe('Custom domains', () => {
			it('should set custom domain', async () => {
				const { set_custom_domain, list_custom_domains } = actor;

				await set_custom_domain('hello.com', ['123456']);
				await set_custom_domain('test2.com', []);

				const results = await list_custom_domains();

				expect(results).toHaveLength(2);

				expect(results[0][0]).toEqual('hello.com');
				expect(results[0][1].bn_id).toEqual(['123456']);
				expect(results[0][1].updated_at).not.toBeUndefined();
				expect(results[0][1].updated_at).toBeGreaterThan(0n);
				expect(results[0][1].created_at).not.toBeUndefined();
				expect(results[0][1].created_at).toBeGreaterThan(0n);

				expect(results[1][0]).toEqual('test2.com');
				expect(results[1][1].bn_id).toEqual([]);
				expect(results[1][1].updated_at).not.toBeUndefined();
				expect(results[1][1].updated_at).toBeGreaterThan(0n);
				expect(results[1][1].created_at).not.toBeUndefined();
				expect(results[1][1].created_at).toBeGreaterThan(0n);
			});

			it('should expose /.well-known/ic-domains', async () => {
				const { http_request } = actor;

				const { body } = await http_request({
					body: [],
					certificate_version: toNullable(),
					headers: [],
					method: 'GET',
					url: '/.well-known/ic-domains'
				});

				const decoder = new TextDecoder();
				expect(decoder.decode(body as ArrayBuffer)).toContain('hello.com');
				expect(decoder.decode(body as ArrayBuffer)).toContain('test2.com');
			});

			it('could delete custom domain', async () => {
				const { set_custom_domain, list_custom_domains, del_custom_domain } = actor;

				await set_custom_domain('test3.com', ['123456']);

				const resultsBefore = await list_custom_domains();

				// Two previous domains + test3
				expect(resultsBefore).toHaveLength(3);

				await del_custom_domain('hello.com');

				const resultsAfter = await list_custom_domains();

				expect(resultsAfter).toHaveLength(2);
			});

			it('should create asset ic-domains', async () => {
				const { get_asset } = actor;

				// We assumed previous test has run
				const asset = await get_asset('#dapp', '/.well-known/ic-domains');
				expect(asset[0]?.key.full_path).toEqual('/.well-known/ic-domains');
			});

			it('should not delete asset ic-domains when deleting all assets', async () => {
				const { get_asset, del_assets } = actor;

				await del_assets('#dapp');

				const asset = await get_asset('#dapp', '/.well-known/ic-domains');
				expect(asset[0]?.key.full_path).toEqual('/.well-known/ic-domains');
			});

			it('should throw error if try to upload ic-domains', async () => {
				const { init_asset_upload } = actor;

				await expect(
					init_asset_upload({
						collection: '#dapp',
						description: toNullable(),
						encoding_type: [],
						full_path: '/.well-known/ic-domains',
						name: 'ic-domains',
						token: toNullable()
					})
				).rejects.toThrow('/.well-known/ic-domains is a reserved asset.');
			});
		});

		describe.each([{ memory: { Heap: null } }, { memory: { Stable: null } }])(
			'With collection',
			({ memory }) => {
				const collection = `test_${'Heap' in memory ? 'heap' : 'stable'}`;

				it('should create a collection', async () => {
					const { set_rule, list_rules } = actor;

					const setRule: SetRule = {
						memory: toNullable(memory),
						updated_at: toNullable(),
						max_size: toNullable(),
						max_capacity: toNullable(),
						read: { Managed: null },
						mutable_permissions: toNullable(),
						write: { Managed: null }
					};

					await set_rule({ Storage: null }, collection, setRule);

					const collectionResults = await list_rules({
						Storage: null
					});

					const collectionResult = collectionResults.find(([c, _]) => c === collection);

					expect(collectionResult).not.toBeUndefined();

					const [_, { memory: memoryResult, created_at, updated_at, read, write }] =
						collectionResult!;

					expect(memoryResult).toEqual(toNullable(memory));
					expect(read).toEqual({ Managed: null });
					expect(write).toEqual({ Managed: null });
					expect(created_at).toBeGreaterThan(0n);
					expect(updated_at).toBeGreaterThan(0n);
				});

				it('should throw error if path not prefixed with collection', async () => {
					const { init_asset_upload } = actor;

					await expect(
						init_asset_upload({
							collection,
							description: toNullable(),
							encoding_type: [],
							full_path: '/hello.html',
							name: 'hello.html',
							token: toNullable()
						})
					).rejects.toThrow('Asset path must be prefixed with collection key.');
				});

				it('should deploy asset', async () => {
					const { http_request, commit_asset_upload, upload_asset_chunk, init_asset_upload } =
						actor;

					const file = await init_asset_upload({
						collection,
						description: toNullable(),
						encoding_type: [],
						full_path: `/${collection}/hello.html`,
						name: 'hello.html',
						token: toNullable()
					});

					const HTML = '<html><body>Hello</body></html>';

					const blob = new Blob([HTML], {
						type: 'text/plain; charset=utf-8'
					});

					const chunk = await upload_asset_chunk({
						batch_id: file.batch_id,
						content: arrayBufferToUint8Array(await blob.arrayBuffer()),
						order_id: [0n]
					});

					await commit_asset_upload({
						batch_id: file.batch_id,
						chunk_ids: [chunk.chunk_id],
						headers: []
					});

					const { headers, body } = await http_request({
						body: [],
						certificate_version: toNullable(),
						headers: [],
						method: 'GET',
						url: `/${collection}/hello.html`
					});

					const rest = headers.filter(([header, _]) => header !== 'IC-Certificate');

					expect(rest).toEqual([
						['accept-ranges', 'bytes'],
						['etag', '"03ee66f1452916b4f91a504c1e9babfa201b6d64c26a82b2cf03c3ed49d91585"'],
						['X-Content-Type-Options', 'nosniff'],
						['Strict-Transport-Security', 'max-age=31536000 ; includeSubDomains'],
						['Referrer-Policy', 'same-origin'],
						['X-Frame-Options', 'DENY'],
						['Cache-Control', 'no-cache']
					]);

					const certificate = headers.find(([header, _]) => header === 'IC-Certificate');

					expect(certificate).not.toBeUndefined();

					const [_, value] = certificate as [string, string];
					expect(value.substring(value.indexOf('tree=:'))).toEqual(
						'Heap' in memory
							? 'tree=:2dn3gwGDAktodHRwX2Fzc2V0c4MBggRYIAul/harHvdi5FUoAHF2/hXh1zlY0p5K3Gn6URVICuoOgwGCBFggxFRHOGoXOousZnfXbQt6QvyMsbVpTksIahF6GnUJBWmDAlUvdGVzdF9oZWFwL2hlbGxvLmh0bWyCA1ggA+5m8UUpFrT5GlBMHpur+iAbbWTCaoKyzwPD7UnZFYWCBFggdlqn/B5XDuJD4HA44+DTdKCVOGnEcYLFeFEafUKJFcg=:'
							: 'tree=:2dn3gwGDAktodHRwX2Fzc2V0c4MBggRYIOXpvMKmDWcp7up3CRCVXvmjZtkbjB8GJC6NASaC+HwDgwGCBFggsF4I47LVsvGbFoLKHBfFANbFx/U6xmj0mUku3j9E/bGDAlcvdGVzdF9zdGFibGUvaGVsbG8uaHRtbIIDWCAD7mbxRSkWtPkaUEwem6v6IBttZMJqgrLPA8PtSdkVhYIEWCBer6FiOS9d/c8ADngIGfcIoi5/aYWtTA8uzLBA30q+Bg==:'
					);

					const decoder = new TextDecoder();
					expect(decoder.decode(body as ArrayBuffer)).toEqual(HTML);
				});

				it('should not delete other collection assets', async () => {
					const { get_asset, del_assets } = actor;

					await del_assets('#dapp');

					const assetUploaded = await get_asset(collection, `/${collection}/hello.html`);
					expect(fromNullable(assetUploaded)).not.toBeUndefined();
				});
			}
		);
	});
});