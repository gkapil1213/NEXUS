# Phase 215 - Planning + Architecture

## EngineeringRequest

id, runId, requestText, requestHash, createdBy, metadata, createdAt.
requestHash = sha256(runId | normalized(text)). UNIQUE (run_id, request_hash).

## EngineeringPlan

status in DRAFT | VALIDATING | VALID | INVALID | SUPERSEDED.
UNIQUE (run_id, version). contentHash = sha256(canonical content JSON).

## ArchitectureSpecification

architectureId, runId, planId, version, systemOverview, components[],
interfaces[], dataModel[], runtimeModel[], securityModel[], deploymentModel[],
observabilityModel[], failureHandling, technologyDecisions[], constraints[],
verificationStrategy[], status, contentHash. UNIQUE (run_id, version).

## Validation

validateEngineeringPlan: objective present; requirements/constraints arrays
with id+text; acceptance criteria non-empty; planned stages non-empty, ids
unique, deps reference valid ids, DAG acyclic (detectCycle); contentHash
matches.

validateArchitectureSpecification: referenced plan exists and is VALID;
planId/runId/version match; components non-empty with unique ids; component
graph acyclic; interfaces reference valid components; verificationStrategy
non-empty; contentHash matches.
