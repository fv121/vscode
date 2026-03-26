/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableFromEvent } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { extractArtifactsFromResponse } from '../common/chatArtifactExtraction.js';
import { ChatConfiguration } from '../common/constants.js';
import { IChatModel } from '../common/model/chatModel.js';
import { IArtifactGroupConfig, IChatArtifact, IChatArtifactsService } from '../common/tools/chatArtifactsService.js';

interface IResponseCache {
	readonly partsLength: number;
	readonly artifacts: IChatArtifact[];
}

/**
 * Bridges a chat model to the artifact service using deterministic extraction rules.
 * Created per chat widget when artifacts mode is "rules".
 *
 * Observable pipeline:
 *   config observables + model signal → derived(artifacts) → autorun → service.setArtifacts()
 */
export class ChatArtifactRulesExtractor extends Disposable {

	private readonly _responseCache = new Map<string, IResponseCache>();

	constructor(
		private readonly _model: IChatModel,
		private readonly _sessionResource: URI,
		@IChatArtifactsService private readonly _chatArtifactsService: IChatArtifactsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		const configByMimeType = observableFromEvent<Record<string, IArtifactGroupConfig>>(
			this,
			this._configurationService.onDidChangeConfiguration,
			() => this._configurationService.getValue<Record<string, IArtifactGroupConfig>>(ChatConfiguration.ArtifactsRulesByMimeType) ?? {},
		);

		const configByFilePath = observableFromEvent<Record<string, IArtifactGroupConfig>>(
			this,
			this._configurationService.onDidChangeConfiguration,
			() => this._configurationService.getValue<Record<string, IArtifactGroupConfig>>(ChatConfiguration.ArtifactsRulesByFilePath) ?? {},
		);

		const modelSignal = observableFromEvent(
			this,
			this._model.onDidChange,
			() => this._model.getRequests(),
		);

		const computedArtifacts = derived<readonly IChatArtifact[]>(reader => {
			const byMimeType = configByMimeType.read(reader);
			const byFilePath = configByFilePath.read(reader);
			const requests = modelSignal.read(reader);

			const allArtifacts: IChatArtifact[] = [];
			const activeResponseIds = new Set<string>();
			const seenKeys = new Set<string>();

			for (const request of requests) {
				const response = request.response;
				if (!response) {
					continue;
				}

				activeResponseIds.add(response.id);
				const responseValue = response.response;
				const partsLength = responseValue.value.length;

				// Check cache: if parts length unchanged, reuse cached artifacts
				const cached = this._responseCache.get(response.id);
				let extracted: IChatArtifact[];
				if (cached && cached.partsLength === partsLength) {
					extracted = cached.artifacts;
				} else {
					// Extract and cache
					extracted = extractArtifactsFromResponse(responseValue, this._sessionResource, byMimeType, byFilePath);
					this._responseCache.set(response.id, { partsLength, artifacts: extracted });
				}

				// Deduplicate across responses — later responses win (overwrite earlier)
				for (const artifact of extracted) {
					const key = artifact.toolCallId
						? `${artifact.toolCallId}:${artifact.dataPartIndex}`
						: artifact.uri;
					if (seenKeys.has(key)) {
						// Remove the earlier duplicate
						const idx = allArtifacts.findIndex(a =>
							a.toolCallId ? `${a.toolCallId}:${a.dataPartIndex}` === key : a.uri === key
						);
						if (idx !== -1) {
							allArtifacts.splice(idx, 1);
						}
					}
					seenKeys.add(key);
					allArtifacts.push(artifact);
				}
			}

			// Prune cache entries for removed responses
			for (const key of this._responseCache.keys()) {
				if (!activeResponseIds.has(key)) {
					this._responseCache.delete(key);
				}
			}

			return allArtifacts;
		});

		this._register(autorun(reader => {
			const artifacts = computedArtifacts.read(reader);
			this._chatArtifactsService.setArtifacts(this._sessionResource, [...artifacts]);
		}));
	}
}
