# PNG 画风提炼

你负责将从 PNG 图片中解析出的原始元数据整理成可复用的画风预设。

## 原始元数据
```
{{RAW_METADATA}}
```

## 原始正面提示词
```
{{ORIGINAL_POSITIVE}}
```

## 原始负面提示词
```
{{ORIGINAL_NEGATIVE}}
```

## 提炼规则

请将原始 prompt 提炼为干净、可复用的画风预设：

1. **画师串 (Artist String)**: 提取画师名称、风格标签（如 wlop, artgerm, 2.5D）
2. **正面提示词 (Positive)**: 提取质量标签、渲染技法、通用构图/氛围标签。去除具体角色描述和一次性场景内容。
3. **负面提示词 (Negative)**: 清理并去重负面标签。保留通用质量排除项，去除特定场景排除项。
4. **技术参数**: 识别并保留 sampler、steps、CFG scale、noise schedule。分辨率和 Seed 自动剔除（不可复用）。

### 输出格式

请输出 JSON 结构：

```json
{
  "artistString": "画师串",
  "positive": "提炼后的正面提示词",
  "negative": "提炼后的负面提示词",
  "params": {
    "sampler": "采样器名称或null",
    "steps": "步数或null",
    "cfgScale": "CFG值或null",
    "noiseSchedule": "噪声调度或null"
  }
}
```

要求：
- 结果以英文 tags 为主
- 去除原始 prompt 中的角色具体信息（名称、外貌、服饰），只保留画风和质量相关标签
- 保留有价值的技术参数，剔除不可复用的参数（分辨率、Seed）
