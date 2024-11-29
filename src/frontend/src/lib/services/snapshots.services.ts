import type { snapshot, snapshot_id } from '$declarations/ic/ic.did';
import {
	canisterSnapshots,
	canisterStart,
	canisterStop,
	createSnapshot as createSnapshotApi,
	restoreSnapshot as restoreSnapshotApi
} from '$lib/api/ic.api';
import { i18n } from '$lib/stores/i18n.store';
import { snapshotStore } from '$lib/stores/snapshot.store';
import { toasts } from '$lib/stores/toasts.store';
import type { OptionIdentity } from '$lib/types/itentity';
import { type SnapshotProgress, SnapshotProgressStep } from '$lib/types/snapshot';
import type { Identity } from '@dfinity/agent';
import type { Principal } from '@dfinity/principal';
import { assertNonNullish, nonNullish } from '@dfinity/utils';
import { get } from 'svelte/store';

type SnapshotOnProgress = (progress: SnapshotProgress | undefined) => void;

interface SnapshotParams {
	canisterId: Principal;
	identity: OptionIdentity;
	onProgress: SnapshotOnProgress;
}

interface CreateSnapshotParams extends SnapshotParams {
	snapshotId?: snapshot_id;
}

interface RestoreSnapshotParams extends SnapshotParams {
	snapshot: snapshot;
}

export const createSnapshot = async ({
	identity,
	canisterId,
	snapshotId,
	...rest
}: CreateSnapshotParams): Promise<{ success: 'ok' | 'cancelled' | 'error'; err?: unknown }> => {
	try {
		assertNonNullish(identity, get(i18n).core.not_logged_in);

		const create = async () => await takeSnapshot({ canisterId, snapshotId, identity });

		await executeSnapshot({
			canisterId,
			identity,
			action: create,
			...rest
		});
	} catch (err: unknown) {
		const labels = get(i18n);

		toasts.error({
			text: labels.errors.snapshot_create_error,
			detail: err
		});

		return { success: 'error', err };
	}

	return { success: 'ok' };
};

export const restoreSnapshot = async ({
	canisterId,
	identity,
	snapshot,
	...rest
}: RestoreSnapshotParams): Promise<{ success: 'ok' | 'cancelled' | 'error'; err?: unknown }> => {
	try {
		assertNonNullish(identity, get(i18n).core.not_logged_in);

		const restore = async () => await applySnapshot({ canisterId, snapshot, identity });

		await executeSnapshot({
			canisterId,
			identity,
			action: restore,
			...rest
		});
	} catch (err: unknown) {
		const labels = get(i18n);

		toasts.error({
			text: labels.errors.snapshot_restore_error,
			detail: err
		});

		return { success: 'error', err };
	}

	return { success: 'ok' };
};

export const executeSnapshot = async ({
	canisterId,
	identity,
	action,
	onProgress
}: Pick<SnapshotParams, 'canisterId' | 'onProgress'> & {
	identity: Identity;
	action: () => Promise<void>;
}) => {
	// 1. We stop the canister to prepare for the snapshot creation.
	const stop = async () => await canisterStop({ canisterId, identity });
	await execute({ fn: stop, onProgress, step: SnapshotProgressStep.StoppingCanister });

	try {
		// 2. We create or restore the backup
		await execute({ fn: action, onProgress, step: SnapshotProgressStep.CreateOrRestoreSnapshot });
	} finally {
		// 3. We restart the canister to finalize the process. No matter what.
		const restart = async () => await canisterStart({ canisterId, identity });
		await execute({ fn: restart, onProgress, step: SnapshotProgressStep.RestartingCanister });
	}
};

const takeSnapshot = async ({
	canisterId,
	...rest
}: Pick<CreateSnapshotParams, 'canisterId' | 'snapshotId'> & {
	identity: Identity;
}) => {
	const newSnapshot = await createSnapshotApi({ canisterId, ...rest });

	updateStore({ canisterId, snapshot: newSnapshot });
};

const applySnapshot = async ({
	canisterId,
	snapshot,
	...rest
}: Pick<RestoreSnapshotParams, 'canisterId' | 'snapshot'> & {
	identity: Identity;
}) => {
	await restoreSnapshotApi({ canisterId, snapshotId: snapshot.id, ...rest });

	// We add in store the snapshot we restored because load_canister_snapshot returns void
	updateStore({ canisterId, snapshot });
};

const updateStore = ({
	canisterId,
	snapshot
}: Pick<SnapshotParams, 'canisterId'> & { snapshot: snapshot }) => {
	// Currently the IC only supports once snapshot per canister.
	snapshotStore.set({
		canisterId: canisterId.toText(),
		data: [snapshot]
	});
};

const execute = async ({
	fn,
	step,
	onProgress
}: {
	fn: () => Promise<void>;
	step: SnapshotProgressStep;
	onProgress: SnapshotOnProgress;
}) => {
	onProgress({
		step,
		state: 'in_progress'
	});

	try {
		await fn();

		onProgress({
			step,
			state: 'success'
		});
	} catch (err: unknown) {
		onProgress({
			step,
			state: 'error'
		});

		throw err;
	}
};

export const loadSnapshots = async ({
	canisterId,
	identity,
	reload = false
}: {
	canisterId: Principal;
	identity: OptionIdentity;
	reload?: boolean;
}): Promise<{ success: boolean }> => {
	const canisterIdText = canisterId.toText();

	try {
		assertNonNullish(identity, get(i18n).core.not_logged_in);

		const store = get(snapshotStore);

		if (nonNullish(store?.[canisterIdText]) && !reload) {
			return { success: true };
		}

		const snapshots = await canisterSnapshots({
			canisterId,
			identity
		});

		snapshotStore.set({
			canisterId: canisterIdText,
			data: snapshots
		});

		return { success: true };
	} catch (err: unknown) {
		const labels = get(i18n);

		toasts.error({
			text: labels.errors.snapshot_loading_errors,
			detail: err
		});

		snapshotStore.reset(canisterIdText);

		return { success: false };
	}
};