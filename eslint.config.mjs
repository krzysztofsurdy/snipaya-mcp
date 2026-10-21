import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'build', 'node_modules', '*.mcpb'] },
  js.configs.recommended,
  ...tseslint.configs.recommended
)
