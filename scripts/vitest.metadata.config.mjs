// These contracts read canonical source and committed content. No globalSetup,
// lifecycle scripts, product build, emitted dist, or forge mutation is involved.
export default {
  test: {
    environment: 'node', globals: true, maxWorkers: 2,
    include: [
      'test/specgit-cli/metadata-content.test.ts',
      'test/specgit-cli/contract.test.ts',
      'test/specgit-cli/skills-mirror.test.ts',
      'test/specgit-cli/workflow-security.test.ts',
    ],
    testNamePattern: 'metadata content validation|cross-slice documentation locks|portable skills distribution mirror|workflow security',
  },
};
