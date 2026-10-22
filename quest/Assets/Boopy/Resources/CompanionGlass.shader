Shader "Boopy/CompanionGlass"
{
    Properties
    {
        _BaseColor ("Sculptural material", Color) = (.909804,.921569,.913725,1)
        _LidColor ("Shell eyelid", Color) = (.909804,.921569,.913725,1)
        _Roughness ("Material roughness", Range(0.05,1)) = 0.72
        _Role ("Eye lens material", Range(0,1)) = 0
        _Thin ("Thin glass hand", Range(0,1)) = 0
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
            float _Thin, _Opacity, _EyeOpen, _Clock, _Activity, _Roughness, _Role, _Smile;
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
                // Neutral matte volume, not a simulated transmission or tinted reflection environment.
                float3 materialColor=_BaseColor.rgb;
                float3 color=materialColor*(.56+.44*wrap);
                color+=materialColor*bounce*.035;
                color+=float3(1,1,1)*specular*lerp(.12,.035,_Roughness);
                color+=float3(1,1,1)*fresnel*.018;
                // Actual-state pose carries thought. No periodic glint, chromatic wash or glass alpha.
                float alpha=_Opacity;
                return fixed4(color,alpha);
            }
            ENDCG
        }
    }
}
