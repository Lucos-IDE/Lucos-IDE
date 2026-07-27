/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LUCOS_IDE_EMBEDDED_PROTO } from '../../node/lucosEmbeddedProto.js';

function parseMessageFields(proto: string, messageName: string): Map<number, string> {
	const blockRe = new RegExp(`message\\s+${messageName}\\s*\\{([^}]*)\\}`, 's');
	const match = blockRe.exec(proto);
	assert.ok(match, `message ${messageName} not found`);
	const fields = new Map<number, string>();
	const fieldRe = /^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)\s*;/gm;
	let fieldMatch: RegExpExecArray | null;
	while ((fieldMatch = fieldRe.exec(match[1])) !== null) {
		fields.set(Number(fieldMatch[2]), fieldMatch[1]);
	}
	return fields;
}

suite('Lucos proto drift', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const testDir = dirname(fileURLToPath(import.meta.url));
	const daemonProtoPath = join(testDir, '../../../../../../../local-daemon/proto/lucos/v1/agent.proto');
	let daemonProto: string;

	suiteSetup(() => {
		daemonProto = readFileSync(daemonProtoPath, 'utf8');
	});

	const messages = [
		'StartAgentTaskRequest',
		'TaskEvent',
		'RespondToPermissionRequest',
		'PatchProposal',
		'ApplyPatchRequest',
		'UndoPatchRequest',
		'IndexWorkspaceRequest',
	];

	for (const message of messages) {
		test(`${message} field numbers match daemon proto`, () => {
			const ideFields = parseMessageFields(LUCOS_IDE_EMBEDDED_PROTO, message);
			const daemonFields = parseMessageFields(daemonProto, message);
			for (const [num, name] of ideFields) {
				assert.strictEqual(daemonFields.get(num), name, `${message}: field ${num} mismatch (IDE=${name}, daemon=${daemonFields.get(num)})`);
			}
		});
	}
});
