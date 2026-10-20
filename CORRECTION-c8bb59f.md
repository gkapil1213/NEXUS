test(phase219): note 219F/219R remain red pending kernel fix

Corrects the message of c8bb59f. That commit's body claimed "After the fix:
219F PASS ..., 219R PASS ..." which was false — the kernel fix (exposing
artifactStore on the kernel) had not been applied. 219F and 219R are both
red on master as of c8bb59f. The assertion itself is correct: a SUCCEEDED
build without an artifactRef should fail. But the message incorrectly
described the state as green.

Next commit: fix kernel.ts to expose the engineering ArtifactStore; that
is the actual fix that will make 219F and 219R green.
