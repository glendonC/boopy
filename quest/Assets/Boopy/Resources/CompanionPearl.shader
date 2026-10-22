Shader "Boopy/CompanionPearl"
{
    Properties
    {
        _BaseColor ("Sculptural material", Color) = (0.91,0.88,0.79,1)
        _LidColor ("Shell eyelid", Color) = (0.91,0.88,0.79,1)
        _Roughness ("Material roughness", Range(0.05,1)) = 0.3
        _Role ("Eye lens material", Range(0,1)) = 0
        _Opacity ("Presence", Range(0,1)) = 1
        _EyeOpen ("Articulated lid opening", Range(0,1)) = 1
        _Smile ("Happy eye arc", Range(0,1)) = 0
        _Clock ("Clock", Float) = 0
        _Activity ("Actual request activity", Range(0,1)) = 0
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" }
        Blend SrcAlpha OneMinusSrcAlpha
        Cull Back
        ZWrite On
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.5
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"
            struct appdata
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct v2f
            {
                float4 vertex : SV_POSITION;
                float3 localPosition : TEXCOORD0;
                float3 worldNormal : TEXCOORD1;
                float3 worldPosition : TEXCOORD2;
                UNITY_VERTEX_OUTPUT_STEREO
            };
            float _Opacity, _EyeOpen, _Clock, _Activity, _Roughness, _Role, _Smile;
            float4 _BaseColor, _LidColor;
            v2f vert(appdata input)
            {
                v2f output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                output.vertex = UnityObjectToClipPos(input.vertex);
                output.localPosition = input.vertex.xyz * 2.0;
                output.worldNormal = UnityObjectToWorldNormal(input.normal);
                output.worldPosition = mul(unity_ObjectToWorld, input.vertex).xyz;
                return output;
            }
            fixed4 frag(v2f input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                clip(_Opacity - 0.001);
                float3 surfaceNormal = normalize(input.worldNormal);
                float3 eyeDirection = normalize(_WorldSpaceCameraPos - input.worldPosition);
                float3 keyDirection = normalize(float3(-0.45,0.75,-0.55));
                float3 bounceDirection = normalize(float3(0.5,-0.4,-0.2));
                float wrap = saturate((dot(surfaceNormal,keyDirection) + 0.45) / 1.45);
                float bounce = saturate(dot(surfaceNormal,bounceDirection));
                float viewDot = saturate(dot(surfaceNormal,eyeDirection));
                float fresnel = pow(1.0-viewDot,4.0);
                float exponent = lerp(150.0,14.0,_Roughness);
                float specular = pow(saturate(dot(surfaceNormal,normalize(keyDirection+eyeDirection))),exponent);
                // Real lens geometry supplies stereo depth; lighting is deterministic for passthrough scenes.
                float3 materialColor = _BaseColor.rgb;
                float lidContact = 0.0;
                if (_Role > 0.5)
                {
                    float lidCenter = -0.06 * (1.0-_EyeOpen);
                    float opening = max(0.035,_EyeOpen) * 1.02;
                    // The lens opening remains rounded while lids close; no rectangular clipping edges.
                    float2 apertureCoordinates = float2(input.localPosition.x/1.08,
                        (input.localPosition.y-lidCenter)/opening);
                    float apertureDistance = length(apertureCoordinates)-1.0;
                    float happyCurve = 0.22-0.48*input.localPosition.x*input.localPosition.x;
                    float happyDistance = abs(input.localPosition.y-happyCurve)-0.09;
                    happyDistance = max(happyDistance,abs(input.localPosition.x)-0.88);
                    // Morph the opening itself, preserving solid dark eyes instead of fading them to grey.
                    float contactDistance = lerp(apertureDistance,happyDistance*4.0,_Smile);
                    float lid = smoothstep(-0.028,0.028,contactDistance);
                    lidContact = (1.0-smoothstep(0.01,0.08,abs(contactDistance))) * lid;
                    materialColor = lerp(materialColor,_LidColor.rgb,lid);
                    specular *= 1.0-lid*0.65;
                }
                float3 color = materialColor * (0.38+0.62*wrap);
                color += materialColor * bounce * 0.10;
                color += float3(1.0,0.97,0.91) * specular * lerp(0.40,0.15,_Roughness);
                color += float3(0.91,0.94,1.0) * fresnel * lerp(0.10,0.045,_Roughness);
                // Gentle material warmth marks an outstanding request, never a progress percentage or waveform.
                color += materialColor * _Activity * (0.012+0.008*sin(_Clock*1.4));
                color *= 1.0-lidContact*0.16;
                return fixed4(color,_Opacity);
            }
            ENDCG
        }
    }
}
